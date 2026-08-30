/**
 * analyze-url.mjs —— Legado URL 规则蒸馏：模板变量、选项 JSON、相对解析、编码。
 *
 * 支持：
 *   - url,{options} 切分（在第一个能 JSON.parse 的 ",{" 处切；body 里常见 ,\n{）
 *   - options: charset / method / body / headers / retry（webView/js/proxy 等忽略并告警）
 *   - {{key}}（GET 按 charset 百分号编码）/ {{page}}（从 1 起）/ <,{{page}}>（page=1 时整段省略）
 *   - POST body 按 charset 转 字节（iconv），utf-8 时直接字符串
 *   - 相对 URL 基于 baseUrl 解析
 */
import iconv from 'iconv-lite';

/** 切分 url 与选项 JSON：找第一个 ",{" 使尾部能 JSON.parse 的切点。 */
export function splitUrlOptions(urlRule) {
  const s = urlRule.trim();
  let idx = s.indexOf(',{');
  while (idx !== -1) {
    const tail = s.slice(idx + 1);
    try {
      const options = JSON.parse(tail);
      return { url: s.slice(0, idx).trim(), options };
    } catch {
      idx = s.indexOf(',{', idx + 1);
    }
  }
  return { url: s, options: {} };
}

/**
 * 组装最终请求。
 * @param {string} urlRule 规则串（可含选项）
 * @param {object} p { baseUrl, key, page, defaultHeaders, sourceHeaders, onUnsupported }
 * @returns {{ url, method, body?, bodyBytes?, headers, charset, retry }}
 */
export function buildRequest(urlRule, p) {
  const { url: rawUrl, options } = splitUrlOptions(urlRule);
  const warn = p.onUnsupported ?? (() => {});
  for (const k of ['webView', 'js', 'bodyJs', 'proxy', 'dnsIp', 'type']) {
    if (options[k] !== undefined) warn(`URL 选项 ${k} v1 忽略`);
  }
  const charset = String(options.charset ?? 'utf-8').toLowerCase();
  const method = (options.method ?? 'GET').toUpperCase();

  // 模板变量：<,{{page}}> 特殊段（page=1 整段省略）先处理，再替换 {{key}}/{{page}}
  const fillTemplate = (s) => {
    let out = s.replace(/<([^{}]*\{\{page\}\}[^{}]*)>/g, (_, frag) => {
      const page = String(p.page ?? 1);
      return page === '1' ? '' : frag.replace(/\{\{page\}\}/g, page);
    });
    out = out.replace(/\{\{key\}\}/g, '{key}').replace(/\{\{page\}\}/g, String(p.page ?? 1));
    return out;
  };
  let url = fillTemplate(rawUrl);
  let body = options.body != null ? fillTemplate(String(options.body)) : undefined;
  url = url.replaceAll('{key}', encodeKeyToCharset(p.key ?? '', charset));
  if (body) body = body.replaceAll('{key}', p.key ?? '');

  const resolved = resolveUrl(url, p.baseUrl);
  const headers = mergeHeaders(p.defaultHeaders, p.sourceHeaders, options.headers);
  let bodyBytes;
  if (body !== undefined && !['utf-8', 'utf8'].includes(charset)) {
    bodyBytes = iconv.encode(body, charset);
    body = undefined;
  }
  return { url: resolved, method, body, bodyBytes, headers, charset, retry: Number(options.retry ?? 0) || 0 };
}

/** key 按 charset 百分号编码：编码为 charset 字节流后逐字节转 %XX（latin1 桥）。 */
function encodeKeyToCharset(key, charset) {
  if (['utf-8', 'utf8'].includes(charset)) return encodeURIComponent(key);
  try {
    const bytes = iconv.encode(key, charset);
    let out = '';
    for (const b of bytes) {
      const c = String.fromCharCode(b);
      out += /[A-Za-z0-9-_.!~*'()]/.test(c) ? c : encodeURIComponent(c);
    }
    return out;
  } catch {
    return encodeURIComponent(key);
  }
}

/** 相对 URL 基于 baseUrl 解析；无法解析时原样返回。 */
export function resolveUrl(url, baseUrl) {
  if (!baseUrl) return url;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

/** headers 合并优先级：默认 < 书源 < URL 选项。 */
function mergeHeaders(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!layer) continue;
    const obj = typeof layer === 'string' ? parseJsonObject(layer) : layer;
    if (!obj) continue;
    for (const [k, v] of Object.entries(obj)) {
      if (k.toLowerCase() === 'proxy') continue;
      out[k] = String(v);
    }
  }
  return out;
}

/**
 * 宽松 JSON 对象解析。书源里的 header / options / replaceRegex 大量使用
 * 单引号伪 JSON（Legado 的 Gson 宽松模式能吃下，严格 JSON.parse 不能），
 * 依次尝试：严格 → 单引号归一 → 去尾逗号 → 两者叠加。
 */
export function parseJsonObject(s) {
  if (!s || typeof s !== 'string') return null;
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  const attempts = [
    t,
    t.replace(/'/g, '"'),
    t.replace(/,(\s*[}\]])/g, '$1'),
    t.replace(/'/g, '"').replace(/,(\s*[}\]])/g, '$1'),
  ];
  for (const cand of attempts) {
    try {
      const v = JSON.parse(cand);
      return typeof v === 'object' && v !== null ? v : null;
    } catch { /* 下一种形态 */ }
  }
  return null;
}
