/**
 * fetcher.mjs —— 限速抓取器（蒸馏 Legado 的并发率/CookieJar/重试，叠加 qidian-ssr 纪律）。
 *
 * 纪律（来自本项目试车台教训）：
 *   - 随机限速缺省 2500–4500ms/请求（可 --delay 覆盖），单请求超时缺省 20s
 *   - 失败重试 2 次指数退避；连续 3 次失败或命中反爬特征 → 阻塞即停
 *   - CookieJar：按 host 保存 Set-Cookie，随请求回传（Legado enabledCookieJar 的本地版）
 *   - 响应按 options.charset 解码（gbk/big5/utf-8）
 *   - 抓取器必须自证完整性： decodeText 与 fetchText 返回 { body, status, finalUrl }，
 *     语义完整性由上层用平台自报字数/分布对账，本模块只负责传输层真实。
 */
import iconv from 'iconv-lite';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const BLOCK_PATTERNS = [
  /验证码/, /captcha/i, /滑动验证/, /访问过于频繁/, /异常访问/, /请开启.{0,6}javascript/i,
  /防火墙/, /blocked/i, /forbidden/i, /人机识别/,
];

export class FetchBlockedError extends Error {
  constructor(message, url) {
    super(message);
    this.name = 'FetchBlockedError';
    this.url = url;
  }
}

export class Fetcher {
  /**
   * @param {object} opts { delayMinMs, delayMaxMs, timeoutMs, retries, cookieFile, quiet }
   */
  constructor(opts = {}) {
    this.delayMin = opts.delayMinMs ?? 2500;
    this.delayMax = opts.delayMaxMs ?? 4500;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 2;
    this.cookieFile = opts.cookieFile ?? null;
    this.quiet = opts.quiet ?? false;
    this.cookieJar = opts.cookieFile && existsSync(opts.cookieFile) ? readJson(opts.cookieFile) : {};
    this.failStreak = 0;
    this.lastRequestAt = 0;
  }

  async #throttle() {
    const gap = this.delayMin + Math.random() * Math.max(0, this.delayMax - this.delayMin);
    const wait = Math.max(0, this.lastRequestAt + gap - Date.now());
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  #storeCookies(responseUrl, headers) {
    const setCookies = headers?.getSetCookie?.() ?? [];
    if (setCookies.length === 0) return;
    let host;
    try {
      host = new URL(responseUrl).hostname;
    } catch {
      return;
    }
    const jar = this.cookieJar[host] ?? {};
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    this.cookieJar[host] = jar;
    if (this.cookieFile) writeJson(this.cookieFile, this.cookieJar);
  }

  #cookieHeader(url) {
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    const jar = this.cookieJar[host];
    if (!jar || Object.keys(jar).length === 0) return null;
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /**
   * 抓一个 URL。
   * @param {object} req { url, method, body, bodyBytes, headers, charset, retry }
   */
  async fetch(req) {
    await this.#throttle();
    let lastErr = null;
    const attempts = 1 + Math.max(this.retries, req.retry ?? 0);
    for (let a = 0; a < attempts; a++) {
      try {
        const headers = { ...req.headers };
        const cookie = this.#cookieHeader(req.url);
        if (cookie && !Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) {
          headers.Cookie = cookie;
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(new Error(`超时 ${this.timeoutMs}ms`)), this.timeoutMs);
        let res;
        try {
          res = await fetch(req.url, {
            method: req.method ?? 'GET',
            headers,
            body: req.bodyBytes ?? req.body,
            signal: ctrl.signal,
            redirect: 'follow',
          });
        } finally {
          clearTimeout(timer);
        }
        this.#storeCookies(res.url || req.url, res.headers);
        const buf = Buffer.from(await res.arrayBuffer());
        const charset = req.charset || sniffCharset(res.headers.get('content-type')) || 'utf-8';
        const body = decodeBuffer(buf, charset);
        if (!res.ok) {
          if ([403, 429, 503].includes(res.status)) {
            this.failStreak += 1;
            if (this.failStreak >= 3) throw new FetchBlockedError(`HTTP ${res.status} 连续 ${this.failStreak} 次，疑似反爬，阻塞即停: ${req.url}`, req.url);
            lastErr = new Error(`HTTP ${res.status}`);
            await sleep(1500 * (a + 1));
            continue;
          }
          throw new FetchBlockedError(`HTTP ${res.status} ${res.statusText}: ${req.url}`, req.url);
        }
        if (BLOCK_PATTERNS.some((p) => p.test(body.slice(0, 3000)))) {
          throw new FetchBlockedError(`响应命中反爬特征（前 3000 字符内），阻塞即停: ${req.url}`, req.url);
        }
        this.failStreak = 0;
        return { body, status: res.status, finalUrl: res.url || req.url };
      } catch (err) {
        if (err instanceof FetchBlockedError) throw err;
        if (err?.name === 'AbortError') lastErr = new Error(`超时 ${this.timeoutMs}ms: ${req.url}`);
        else lastErr = err;
        if (a < attempts - 1) await sleep(1200 * (a + 1));
      }
    }
    throw lastErr ?? new Error('抓取失败');
  }
}

export function decodeBuffer(buf, charset) {
  if (['utf-8', 'utf8'].includes(charset)) return buf.toString('utf8');
  if (iconv.encodingExists(charset)) return iconv.decode(buf, charset);
  return buf.toString('utf8');
}

function sniffCharset(contentType) {
  if (!contentType) return null;
  const m = /charset=([\w-]+)/i.exec(contentType);
  return m ? m[1].toLowerCase() : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
