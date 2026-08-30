#!/usr/bin/env node
/**
 * gui-server.mjs —— yuedu-distill 本地图形界面（127.0.0.1 单机 HTTP 服务）。
 *
 * 启动：node gui-server.mjs [--port 8765] [--no-open]
 *   - 默认从 8765 起扫描空闲端口；win32 下自动打开浏览器（--no-open 关闭）
 *   - 只绑 127.0.0.1，不对外网暴露
 *
 * 接口（全部 JSON）：
 *   GET  /                     界面页（gui.html）
 *   GET  /api/sources?kw=      书源列表（带静态验证画像，内存缓存）
 *   POST /api/search           {sourceKey, keyword, limit} 搜索书
 *   GET  /api/toc?source=&url= 目录预览
 *   POST /api/fetch            {sourceKey, bookUrl, outDir, max, resume, minChars,
 *                               delayMin, delayMax, cookie, builtinClean, userRules}
 *                               → {jobId} 后台任务；进度轮询 GET /api/job/:id
 *   GET  /api/job/:id          {status, log, progress, report}
 *   POST /api/job/:id/stop     停止任务（章节间生效，已抓章保留，配合 --resume 可续）
 *   GET  /api/jobs             任务列表
 *   POST /api/clean            {file, out, builtinClean} 单文件净化
 *   GET  /api/out-default      默认输出目录
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { exec } from 'node:child_process';

import { loadSourcesDir, pickSource, validateSource } from './src/source.mjs';
import { makeCtx, searchBooks, fetchBookInfo, fetchToc, fetchBook } from './src/pipeline.mjs';
import { cleanContent, toParagraphs, BUILTIN_RULES } from './src/clean.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TOOL_DIR, '..', '..');
const SOURCES_DIR = path.join(TOOL_DIR, 'sources');
const COOKIE_FILE = path.join(ROOT, '.bench', 'yuedu', '.cookies.json');
const USER_RULES = path.join(TOOL_DIR, 'clean-rules.user.json');

// ---------- 书源与画像（进程内缓存，源文件 mtime 变化自动失效） ----------
import { readdirSync, statSync } from 'node:fs';
let sourcesCache = null;
let verdictsCache = null;
let cacheStamp = 0;
function sourcesStamp() {
  let max = 0;
  for (const f of readdirSync(SOURCES_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { max = Math.max(max, statSync(path.join(SOURCES_DIR, f)).mtimeMs); } catch { /* 并发写 */ }
  }
  return max;
}
function ensureFresh() {
  const stamp = sourcesStamp();
  if (stamp !== cacheStamp) {
    cacheStamp = stamp;
    sourcesCache = loadSourcesDir(SOURCES_DIR);
    verdictsCache = new Map();
    for (const s of sourcesCache) {
      try { verdictsCache.set(s.bookSourceUrl, validateSource(s)); } catch { /* 单源画像失败不影响列表 */ }
    }
  }
  return sourcesCache;
}
function allSources() {
  ensureFresh();
  return sourcesCache;
}
function verdictMap() {
  ensureFresh();
  return verdictsCache;
}

function sourceBrief(s) {
  const v = verdictMap().get(s.bookSourceUrl);
  return {
    name: s.bookSourceName,
    url: s.bookSourceUrl,
    group: s.bookSourceGroup ?? '',
    verdict: v?.verdict ?? '?',
    unsupported: (v?.unsupported ?? []).slice(0, 4),
  };
}

/** 留空书源时的自动策略：依次试 full 源（≤6 个），第一个出结果的胜出。 */
async function autoSearch(keyword, limit) {
  const full = allSources().map((s, i) => ({ s, i })).filter(({ s }) => verdictMap().get(s.bookSourceUrl)?.verdict === 'full');
  const tried = [];
  for (const { s, i } of full.slice(0, 6)) {
    try {
      const ctx = makeCtx(s, { delayMinMs: 300, delayMaxMs: 700, cookieFile: COOKIE_FILE });
      const results = await searchBooks(ctx, keyword, { limit });
      tried.push(`${i} ${s.bookSourceName}`);
      if (results.length > 0) return { results, used: sourceBrief(s), tried };
    } catch { tried.push(`${i} ${s.bookSourceName}（失败）`); }
  }
  const err = new Error(`自动挑选的 ${tried.length} 个 full 源都没有结果：${tried.join('；')}`);
  err.tried = tried;
  throw err;
}

/** 抓书必须能定位书源：给了 sourceKey 用之；否则按 bookUrl 域名反查。 */
function resolveSourceForFetch(sourceKey, bookUrl) {
  if (sourceKey && String(sourceKey).trim()) return pickSource(allSources(), String(sourceKey).trim());
  try {
    const host = new URL(bookUrl).hostname;
    const hit = allSources().find((s) => { try { return new URL(s.bookSourceUrl).hostname === host; } catch { return false; } });
    if (hit) return hit;
  } catch { /* 相对路径 bookUrl 无法反查 */ }
  throw new Error('无法定位书源：请先搜索选书，或在「书源」框填源名/序号（相对路径的 bookUrl 必须指定源）');
}

// ---------- 抓书任务 ----------
let jobSeq = 0;
const jobs = new Map(); // id → job

function jobView(j) {
  return {
    id: j.id,
    status: j.status,
    error: j.error ?? null,
    progress: j.progress,
    log: j.log.slice(-400),
    report: j.report,
    startedAt: j.startedAt,
    endedAt: j.endedAt ?? null,
  };
}

function runFetchJob(params) {
  const source = resolveSourceForFetch(params.sourceKey, params.bookUrl);
  const outDir = path.resolve(params.outDir && String(params.outDir).trim()
    ? String(params.outDir).trim()
    : path.join(ROOT, '.bench', 'yuedu', 'book'));
  const job = {
    id: ++jobSeq,
    status: 'running',
    log: [],
    progress: { done: 0, total: 0, title: '' },
    report: null,
    stopped: false,
    startedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  const say = (line) => {
    job.log.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`);
    if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
  };
  const controller = { stopped: false };
  job.stop = () => { controller.stopped = true; };

  (async () => {
    say(`书源：${source.bookSourceName}（${source.bookSourceUrl}）`);
    const ctx = makeCtx(source, {
      cookie: params.cookie || undefined,
      delayMinMs: params.delayMin != null && params.delayMin !== '' ? Number(params.delayMin) : undefined,
      delayMaxMs: params.delayMax != null && params.delayMax !== '' ? Number(params.delayMax) : undefined,
      cookieFile: COOKIE_FILE,
    });
    for (const w of ctx.warnings.splice(0)) say(`警告：${w}`);
    const { report, results } = await fetchBook(ctx, params.bookUrl, {
      outDir,
      max: params.max ? Number(params.max) : undefined,
      resume: !!params.resume,
      minChars: params.minChars ? Number(params.minChars) : undefined,
      userRulesFile: existsSync(USER_RULES) ? USER_RULES : undefined,
      builtinClean: params.builtinClean !== false,
      shouldStop: () => controller.stopped,
      onProgress: (done, total, title) => {
        job.progress = { done, total, title };
        if (done % 5 === 0 || done === total || total <= 20) say(`[${done}/${total}] ${title}`);
      },
    });
    for (const w of ctx.warnings.splice(0)) say(`警告：${w}`);
    job.report = report;
    job.progress = { done: results.filter((r) => !r.error).length, total: report.toc.realChapters, title: '完成' };
    say(`完成：成功 ${report.fetched}，失败 ${report.errors.length}，疑点 ${report.suspects} 章 → ${outDir}`);
    if (report.blocked) say(`注意：触发反爬阻塞（${report.blocked.at}），可稍后续抓（勾选“续抓”）`);
    if (report.stopped) say('已按“停止”中断；已抓章节已落盘，勾选“续抓”可从断点继续');
    job.status = report.errors.length > 0 || report.blocked || report.stopped ? 'done-with-warnings' : 'done';
  })().catch((err) => {
    say(`失败：${err.message}`);
    job.status = 'error';
    job.error = err.message;
  }).finally(() => {
    job.endedAt = new Date().toISOString();
  });
  return job;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function send(res, code, data, type = 'application/json; charset=utf-8') {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, readFileSync(path.join(TOOL_DIR, 'gui.html')), MIME['.html']);
    }
    if (req.method === 'GET' && p === '/api/sources') {
      const kw = (u.searchParams.get('kw') ?? '').trim().toLowerCase();
      let list = allSources().map(sourceBrief);
      if (kw) list = list.filter((s) => `${s.name} ${s.url} ${s.group}`.toLowerCase().includes(kw));
      const full = list.filter((s) => s.verdict === 'full').length;
      return send(res, 200, { total: allSources().length, matched: list.length, full, list: list.slice(0, 200) });
    }
    if (req.method === 'GET' && p === '/api/out-default') {
      return send(res, 200, { outDir: path.join(ROOT, '.bench', 'yuedu', 'book'), userRules: existsSync(USER_RULES) });
    }
    if (req.method === 'POST' && p === '/api/search') {
      const b = await readBody(req);
      if (!b.keyword) return send(res, 400, { error: '关键词为空' });
      if (b.sourceKey && String(b.sourceKey).trim()) {
        const source = pickSource(allSources(), String(b.sourceKey).trim());
        const ctx = makeCtx(source, { delayMinMs: 400, delayMaxMs: 900, cookieFile: COOKIE_FILE });
        const results = await searchBooks(ctx, String(b.keyword), { limit: Math.min(Number(b.limit ?? 10), 30) });
        return send(res, 200, { results, used: sourceBrief(source), auto: false });
      }
      const d = await autoSearch(String(b.keyword), Math.min(Number(b.limit ?? 10), 30));
      return send(res, 200, { ...d, auto: true });
    }
    if (req.method === 'GET' && p === '/api/toc') {
      const source = resolveSourceForFetch(u.searchParams.get('source') ?? '', u.searchParams.get('url') ?? '');
      const ctx = makeCtx(source, { delayMinMs: 300, delayMaxMs: 700, cookieFile: COOKIE_FILE });
      const info = await fetchBookInfo(ctx, u.searchParams.get('url') ?? '');
      const { chapters, tocPages } = await fetchToc(ctx, info.tocUrl);
      return send(res, 200, { info, tocPages, count: chapters.length, preview: chapters.slice(0, 50) });
    }
    if (req.method === 'POST' && p === '/api/fetch') {
      const b = await readBody(req);
      if (!b.sourceKey || !b.bookUrl) return send(res, 400, { error: '缺少 sourceKey 或 bookUrl' });
      const job = runFetchJob(b);
      return send(res, 200, { jobId: job.id });
    }
    if (req.method === 'GET' && p.startsWith('/api/job/')) {
      const j = jobs.get(Number(p.split('/')[3]));
      if (!j) return send(res, 404, { error: '任务不存在' });
      return send(res, 200, jobView(j));
    }
    if (req.method === 'POST' && p.startsWith('/api/job/') && p.endsWith('/stop')) {
      const j = jobs.get(Number(p.split('/')[3]));
      if (!j) return send(res, 404, { error: '任务不存在' });
      j.stop?.();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/jobs') {
      return send(res, 200, { jobs: [...jobs.values()].sort((a, b) => b.id - a.id).map(jobView) });
    }
    if (req.method === 'POST' && p === '/api/clean') {
      const b = await readBody(req);
      const file = path.resolve(String(b.file ?? ''));
      if (!existsSync(file)) return send(res, 400, { error: `文件不存在：${file}` });
      const text = readFileSync(file, 'utf8');
      const rulesFile = b.userRules && existsSync(path.resolve(String(b.userRules))) ? path.resolve(String(b.userRules)) : USER_RULES;
      const table = rulesFile && existsSync(rulesFile) ? JSON.parse(readFileSync(rulesFile, 'utf8')) : { rules: [], disabledBuiltin: [] };
      const cleaned = cleanContent(text, { userRules: table, builtin: b.builtinClean !== false });
      const out = b.out && String(b.out).trim() ? path.resolve(String(b.out).trim()) : file.replace(/(\.\w+)?$/, '.cleaned.txt');
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, toParagraphs(cleaned.text), 'utf8');
      return send(res, 200, { out, stats: cleaned.stats });
    }
    if (req.method === 'GET' && p === '/api/clean-rules') {
      const table = existsSync(USER_RULES) ? JSON.parse(readFileSync(USER_RULES, 'utf8')) : { rules: [], disabledBuiltin: [] };
      return send(res, 200, {
        file: USER_RULES,
        rules: Array.isArray(table) ? table : table.rules ?? [],
        disabledBuiltin: Array.isArray(table) ? [] : table.disabledBuiltin ?? [],
        builtins: BUILTIN_RULES,
      });
    }
    if (req.method === 'POST' && p === '/api/clean-rules') {
      const b = await readBody(req);
      const rules = Array.isArray(b.rules) ? b.rules : [];
      for (const r of rules) {
        if (!r || typeof r.name !== 'string' || !r.name.trim() || typeof r.pattern !== 'string' || !r.pattern.trim()) {
          return send(res, 400, { error: '规则表非法：每条需非空 name 与 pattern' });
        }
      }
      const table = {
        rules: rules.map((r) => ({ name: r.name.trim(), pattern: r.pattern, replacement: String(r.replacement ?? ''), ...(r.flags ? { flags: r.flags } : {}), enabled: r.enabled !== false })),
        disabledBuiltin: Array.isArray(b.disabledBuiltin) ? b.disabledBuiltin.filter((x) => typeof x === 'string') : [],
      };
      writeFileSync(USER_RULES, JSON.stringify(table, null, 2) + '\n', 'utf8');
      return send(res, 200, { ok: true, rules: table.rules.length, disabledBuiltin: table.disabledBuiltin.length });
    }
    return send(res, 404, { error: `未知路径 ${p}` });
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
});

function listenOn(startPort, cb) {
  let port = startPort;
  server.on('error', () => {
    port += 1;
    if (port > startPort + 20) {
      console.error(`[yuedu] ${startPort}-${startPort + 20} 端口都被占用，用 --port 指定其他端口`);
      process.exit(1);
    }
    server.listen(port, '127.0.0.1');
  });
  server.listen(port, '127.0.0.1', () => cb(port));
}

const argPort = (() => {
  const i = process.argv.indexOf('--port');
  return i > 0 ? Number(process.argv[i + 1]) : 8765;
})();
const noOpen = process.argv.includes('--no-open');

listenOn(argPort, (port) => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`[yuedu] 图形界面已启动：${url}  （Ctrl+C 退出；源 ${allSources().length} 个）`);
  if (!noOpen && process.platform === 'win32') {
    exec(`start "" "${url}"`, () => {});
  } else if (!noOpen && process.platform === 'darwin') {
    exec(`open "${url}"`, () => {});
  }
});
