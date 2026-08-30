/**
 * pipeline.mjs —— 抓取管线：search → info → toc（多页）→ 逐章正文（翻页）→ 三层净化
 * → 保真度统计 → 导出（manuscript md + book.json + report.md）。
 *
 * 纪律（试车台语料教训的固化）：
 *   - 抓取器必须自证完整性：逐章记 原文长度/净化后长度，分布离群（< 中位 50% 或 < --min-chars）
 *     标 suspect，报告给结论——语义门由上游（番茄 chapterWordNumber / 分布）把关；
 *   - 断点续采：<out>/.state.json 记 chapterUrl→{file,len}，重跑跳过已完成；
 *   - 阻塞即停：连续失败/反爬特征由 fetcher 抛 FetchBlockedError，管线落部分产物 + 报告；
 *   - 溯源：每章 frontmatter 带来源（书源名/URL/章 URL/抓取时间）。
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { evaluateRule, expandTemplates, RuleUnsupportedError } from './analyze-rule.mjs';
import { buildRequest, resolveUrl, parseJsonObject } from './analyze-url.mjs';
import { cleanContent, toParagraphs, parseReplaceRegex } from './clean.mjs';
import { Fetcher, FetchBlockedError, writeJson } from './fetcher.mjs';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 组装管线上下文：书源 + fetcher + 全局 headers。 */
export function makeCtx(source, opts = {}) {
  // 只有 UA 的裸请求会被部分 WAF 边缘按机器人指纹拦（403/404），补齐浏览器常规头
  const defaultHeaders = {
    'User-Agent': DEFAULT_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  const sourceHeaders = parseJsonObject(source.header ?? '') ?? {};
  if (opts.cookie) sourceHeaders.Cookie = opts.cookie;
  const fetcher = new Fetcher({
    delayMinMs: opts.delayMinMs,
    delayMaxMs: opts.delayMaxMs,
    timeoutMs: opts.timeoutMs,
    cookieFile: opts.cookieFile,
    quiet: opts.quiet,
  });
  return { source, defaultHeaders, sourceHeaders, fetcher, warnings: [] };
}

function warn(ctx, msg) {
  if (!ctx.warnings.includes(msg)) ctx.warnings.push(msg);
}

/** 抓取 + 按书源 charset 解码 → { text, $?, json?, finalUrl }（JSON 响应自动切 json 上下文）。 */
async function fetchDocument(ctx, urlRule, p = {}) {
  const req = buildRequest(urlRule, {
    baseUrl: p.baseUrl ?? ctx.source.bookSourceUrl,
    key: p.key,
    page: p.page,
    defaultHeaders: ctx.defaultHeaders,
    sourceHeaders: ctx.sourceHeaders,
    onUnsupported: (m) => warn(ctx, m),
  });
  const res = await ctx.fetcher.fetch(req);
  const trimmed = res.body.trim();
  const isJson = (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  let json;
  if (isJson) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = undefined;
    }
  }
  const $ = json === undefined ? cheerio.load(res.body) : undefined;
  return { text: res.body, $, json, finalUrl: res.finalUrl };
}

/** 空结果诊断：JSON 业务拒绝（HTTP 200 但 code/msg 报错）优先给业务码，否则给响应开头。 */
function respHead(doc) {
  if (doc.json !== undefined && doc.json && typeof doc.json === 'object' && !Array.isArray(doc.json)) {
    const { code, msg } = doc.json;
    if (code !== undefined && msg) return `业务码 ${code}：${msg}`;
  }
  return `响应开头：${String(doc.text).replace(/\s+/g, ' ').slice(0, 160)}`;
}

/** 文档上下文 → 规则求值上下文。 */
function ruleCtx(doc, els = null) {
  if (doc.json !== undefined) {
    return { type: 'json', json: doc.json, baseUrl: doc.finalUrl };
  }
  return { type: 'html', $: doc.$, els, baseUrl: doc.finalUrl };
}

/** 字段求值：文档上下文（html 元素集 / json 对象 / AllInOne 组）+ 模板展开 + 规则求值。 */
function evalField(ctx, rule, doc, { els = null, item = null, groups = null } = {}) {
  if (!rule || !rule.trim()) return null;
  let ruleCtx_;
  if (groups) {
    ruleCtx_ = { type: 'jsonGroups', json: groups, baseUrl: doc.finalUrl };
  } else if (item !== null && doc.json !== undefined) {
    ruleCtx_ = { type: 'json', json: item, baseUrl: doc.finalUrl };
  } else if (doc.json !== undefined && els === null) {
    ruleCtx_ = { type: 'json', json: doc.json, baseUrl: doc.finalUrl }; // 整页 JSON 字段（详情/正文）
  } else {
    ruleCtx_ = { type: 'html', $: doc.$, els, baseUrl: doc.finalUrl };
  }
  // 模板型规则（含 {{...}}，如 /novel/{{$.novelId}}）：展开结果即最终值（字面量+内联规则拼接），
  // 不再二次求值——二次求值会把展开出的 URL 字面量误当规则解析。
  if (rule.includes('{{')) {
    return str(expandTemplates(rule, ruleCtx_, { source: doc.text, onUnsupported: (m) => warn(ctx, m) }));
  }
  const v = evaluateRule(rule, ruleCtx_, { source: doc.text });
  if (v == null) return null;
  return typeof v === 'string' ? v.trim() : String(v);
}

// ---------- search ----------

export async function searchBooks(ctx, keyword, { limit = 10, page = 1 } = {}) {
  const source = ctx.source;
  if (!source.searchUrl) throw new Error('该源无 searchUrl');
  const doc = await fetchDocument(ctx, source.searchUrl, { key: keyword, page });
  const listRule = source.ruleSearch?.bookList;
  if (!listRule) throw new Error('该源无 ruleSearch.bookList');
  const items = evaluateRule(listRule, ruleCtx(doc), { allowList: true, source: doc.text });
  if (!Array.isArray(items)) throw new Error(`bookList 未返回列表（规则: ${listRule}；${respHead(doc)}）`);
  if (items.length === 0) throw new Error(`bookList 为空——搜索被拒或无结果（${respHead(doc)}）`);
  const out = [];
  for (const item of items.slice(0, limit)) {
    const g = source.ruleSearch ?? {};
    const pick = (r) => str(evalField(ctx, r, doc, doc.json !== undefined ? { item } : { els: [item] }));
    out.push({
      name: pick(g.name),
      author: pick(g.author),
      bookUrl: pick(g.bookUrl),
      kind: pick(g.kind),
      coverUrl: pick(g.coverUrl),
      lastChapter: pick(g.lastChapter),
    });
  }
  return out.filter((b) => b.name || b.bookUrl);
}

// ---------- book info ----------

export async function fetchBookInfo(ctx, bookUrl) {
  if (!bookUrl) throw new Error('bookUrl 为空（该源 bookUrl 规则未命中或搜索结果缺链接）');
  const source = ctx.source;
  const doc = await fetchDocument(ctx, bookUrl, { baseUrl: source.bookSourceUrl });
  const g = { ...(source.ruleBookInfo ?? {}) };
  // 详情页预处理（ruleBookInfo.init）：把字段求值上下文切换到 init 规则的结果（如 $.data）
  let viewDoc = doc;
  if (doc.json !== undefined && g.init && String(g.init).trim()) {
    try {
      const initV = evaluateRule(String(g.init), { type: 'json', json: doc.json, baseUrl: doc.finalUrl }, { source: doc.text });
      if (initV && typeof initV === 'object' && !Array.isArray(initV)) {
        viewDoc = { ...doc, json: initV };
      }
    } catch (err) {
      if (!(err instanceof RuleUnsupportedError)) throw err;
      warn(ctx, `ruleBookInfo.init: ${err.message}`);
    }
  }
  delete g.init;
  const pick = (r) => str(evalField(ctx, r, viewDoc));
  const info = {
    name: pick(g.name),
    author: pick(g.author),
    kind: pick(g.kind),
    intro: pick(g.intro),
    coverUrl: pick(g.coverUrl),
    lastChapter: pick(g.lastChapter),
  };
  let tocUrl = pick(g.tocUrl);
  if (!info.name && !tocUrl) {
    throw new Error(`详情页 name/tocUrl 全部未命中——常见原因：接口要求登录态（token 过期）、需要 JS 规则或站点改版。${respHead(doc)}`);
  }
  // 模板型 tocUrl（/novel/{{$.id}}/chapters）展开后丢了关键段（出现 //、undefined）：
  // 说明详情数据被拒/字段不匹配，继续请求只会撞 WAF，直接报业务层原因
  if (tocUrl && String(g.tocUrl ?? '').includes('{{')) {
    const bare = tocUrl.replace(/^https?:\/\//, '');
    if (bare.includes('//') || /\bundefined\b|\bnull\b/.test(bare)) {
      throw new Error(`tocUrl 模板展开缺关键 id——详情数据未命中（接口拒绝或改版）。${respHead(doc)}`);
    }
  }
  info.tocUrl = tocUrl || bookUrl;
  info.bookUrl = doc.finalUrl;
  return info;
}

// ---------- toc ----------

export async function fetchToc(ctx, tocUrl, { maxTocPages = 50 } = {}) {
  const source = ctx.source;
  const g = source.ruleToc ?? {};
  if (!g.chapterList) throw new Error('该源无 ruleToc.chapterList');
  const chapters = [];
  let url = resolveUrl(tocUrl, source.bookSourceUrl);
  const visited = new Set();
  let pages = 0;
  let lastDoc = null;
  while (url && !visited.has(url) && pages < maxTocPages) {
    visited.add(url);
    pages += 1;
    const doc = await fetchDocument(ctx, url, { baseUrl: url });
    lastDoc = doc;
    const listRule = String(g.chapterList ?? '');
    const reverse = listRule.startsWith('-');
    const rule = reverse ? listRule.slice(1) : listRule;
    let items;
    if (rule.startsWith(':')) {
      // AllInOne 正则列表（仅 HTML 形态）
      const rows = evaluateRule(rule, ruleCtx(doc), { allowList: false, source: doc.text });
      items = (Array.isArray(rows) ? rows : [rows]).map((groups) => ({ groups, el: null, item: null }));
    } else {
      const found = evaluateRule(rule, ruleCtx(doc), { allowList: true, source: doc.text });
      const list = (Array.isArray(found) ? found : [found]).filter(Boolean);
      items = list.map((x) => {
        if (doc.json !== undefined) return { groups: null, el: null, item: x };
        return { groups: null, el: x, item: null };
      });
    }
    if (reverse) items.reverse();
    for (const row of items) {
      const evalIn = (r) => evalField(ctx, r, doc, row.groups ? { groups: row.groups } : row.item !== null ? { item: row.item } : { els: [row.el] });
      const name = str(evalIn(g.chapterName));
      const chapterUrlRaw = str(evalIn(g.chapterUrl));
      // 空解析不解析成页面自身 URL：url 与 name 都空的行（如无链接卷行）直接丢弃
      const chapterUrl = chapterUrlRaw ? resolveUrl(chapterUrlRaw, url) : null;
      const isVolumeRaw = str(evalIn(g.isVolume));
      const isVolume = isVolumeRaw != null && !['', 'false', '0', 'null'].includes(isVolumeRaw.toLowerCase());
      if (name || chapterUrl) chapters.push({ title: name ?? '', url: chapterUrl, isVolume });
    }
    // 目录下一页
    if (g.nextTocUrl) {
      let next = null;
      try {
        next = str(evaluateRule(String(g.nextTocUrl), ruleCtx(doc), { source: doc.text }));
      } catch (err) {
        if (!(err instanceof RuleUnsupportedError)) throw err;
        warn(ctx, `nextTocUrl: ${err.message}`);
      }
      url = next ? resolveUrl(next, url) : null;
    } else {
      url = null;
    }
  }
  if (chapters.length === 0 && lastDoc) {
    throw new Error(`目录为空——chapterList 未命中或接口拒绝。${respHead(lastDoc)}`);
  }
  return { chapters, tocPages: pages };
}

// ---------- 正文抓取 + 净化 + 导出 ----------

function userRulesLoad(file) {
  if (!file || !existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[yuedu] 用户净化规则解析失败，忽略: ${err.message}`);
    return [];
  }
}

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'untitled';
}

/**
 * 抓整本书。返回 report 对象；产物写入 outDir。
 * @param {object} ctx makeCtx 结果
 * @param {string} bookUrl 详情页 URL
 * @param {object} opts { outDir, max, resume, minChars, userRulesFile, builtinClean, onProgress }
 */
export async function fetchBook(ctx, bookUrl, opts = {}) {
  const source = ctx.source;
  const outDir = opts.outDir ?? path.join('.bench', 'yuedu', 'book');
  const manuscriptDir = path.join(outDir, 'manuscript');
  mkdirSync(manuscriptDir, { recursive: true });

  const info = await fetchBookInfo(ctx, bookUrl);
  const { chapters, tocPages } = await fetchToc(ctx, info.tocUrl);
  const realChapters = chapters.filter((c) => !c.isVolume && c.url);

  const stateFile = path.join(outDir, '.state.json');
  const state = opts.resume && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { done: {} };
  const userRules = userRulesLoad(opts.userRulesFile ?? path.join(TOOL_DIR, 'clean-rules.user.json'));
  const sourceCleanRules = parseReplaceRegex(source.ruleContent?.replaceRegex ?? '');

  const results = [];
  let blocked = null;
  let stopped = false;
  let doneCount = 0;
  for (let i = 0; i < realChapters.length; i++) {
    if (opts.max && doneCount >= opts.max) break;
    if (opts.shouldStop?.()) { stopped = true; break; }
    const ch = realChapters[i];
    const order = String(i + 1).padStart(4, '0');
    const fileBase = `${order}-${safeName(ch.title)}`;
    if (opts.resume && state.done[ch.url]) {
      results.push({ index: i + 1, title: ch.title, url: ch.url, ...state.done[ch.url], cached: true });
      doneCount += 1;
      continue;
    }
    try {
      const doc = await fetchDocument(ctx, ch.url, { baseUrl: info.tocUrl });
      let contentParts = [];
      let pageUrl = ch.url;
      const visited = new Set();
      for (let p = 0; p < 30 && pageUrl && !visited.has(pageUrl); p++) {
        visited.add(pageUrl);
        const d = pageUrl === doc.finalUrl && p === 0 ? doc : await fetchDocument(ctx, pageUrl, { baseUrl: pageUrl });
        const contentRule = String(source.ruleContent?.content ?? 'text');
        let raw;
        if (d.json !== undefined) {
          raw = evaluateRule(contentRule, { type: 'json', json: d.json, baseUrl: d.finalUrl }, { source: d.text });
        } else {
          raw = evaluateRule(contentRule, { type: 'html', $: d.$, els: null, baseUrl: d.finalUrl }, { source: d.text });
        }
        if (raw) contentParts.push(String(raw));
        if (source.ruleContent?.nextContentUrl) {
          let next = null;
          try {
            next = str(evaluateRule(String(source.ruleContent.nextContentUrl), ruleCtx(d), { source: d.text }));
          } catch (err) {
            if (!(err instanceof RuleUnsupportedError)) throw err;
            warn(ctx, `nextContentUrl: ${err.message}`);
            break;
          }
          pageUrl = next ? resolveUrl(next, d.finalUrl) : null;
        } else {
          pageUrl = null;
        }
      }
      const rawContent = contentParts.join('\n').trim();
      const cleaned = cleanContent(rawContent, {
        sourceRules: sourceCleanRules,
        userRules,
        builtin: opts.builtinClean !== false,
      });
      const body = toParagraphs(cleaned.text);
      const file = path.join(manuscriptDir, `${fileBase}.md`);
      const fm = [
        '---',
        `title: ${ch.title.replace(/\n/g, ' ')}`,
        `index: ${i + 1}`,
        'status: 语料',
        `source: ${source.bookSourceName ?? ''} (${source.bookSourceUrl ?? ''})`,
        `chapterUrl: ${ch.url}`,
        `fetchedAt: ${new Date().toISOString()}`,
        `rawChars: ${rawContent.length}`,
        `chars: ${body.length}`,
        '---',
        '',
        body,
        '',
      ].join('\n');
      writeFileSync(file, fm, 'utf8');
      const rec = { index: i + 1, title: ch.title, url: ch.url, file: path.basename(file), rawChars: rawContent.length, chars: body.length, cleanedBy: summarizeClean(cleaned.stats) };
      results.push(rec);
      state.done[ch.url] = { file: path.basename(file), rawChars: rawContent.length, chars: body.length };
      writeJson(stateFile, state);
      doneCount += 1;
      if (opts.onProgress) opts.onProgress(doneCount, realChapters.length, ch.title);
    } catch (err) {
      if (err instanceof FetchBlockedError) {
        blocked = { at: ch.title, url: ch.url, message: err.message };
        break; // 阻塞即停
      }
      results.push({ index: i + 1, title: ch.title, url: ch.url, error: err.message });
      doneCount += 1;
    }
  }

  // 保真度统计
  const lens = results.filter((r) => !r.error).map((r) => r.chars);
  const sorted = [...lens].sort((a, b) => a - b);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
  const minChars = opts.minChars ?? Math.max(Math.floor(median * 0.5), 200);
  let suspects = 0;
  for (const r of results) {
    if (r.error) continue;
    r.suspect = r.chars < minChars;
    if (r.suspect) suspects += 1;
  }

  const report = {
    book: { name: info.name, author: info.author, kind: info.kind, intro: info.intro, tocUrl: info.tocUrl },
    source: { name: source.bookSourceName, url: source.bookSourceUrl, group: source.bookSourceGroup },
    toc: { total: chapters.length, volumes: chapters.filter((c) => c.isVolume).length, realChapters: realChapters.length, pages: tocPages },
    fetched: results.filter((r) => !r.error).length,
    errors: results.filter((r) => r.error),
    blocked,
    stopped,
    suspects,
    fidelity: { medianChars: median, minChars, suspectThreshold: minChars },
    cleanupLayers: summarizeCleanStats(results),
    warnings: ctx.warnings,
    outDir,
    finishedAt: new Date().toISOString(),
  };
  writeJson(path.join(outDir, 'book.json'), {
    ...info,
    source: report.source,
    chapters: results.map(({ index, title, url, file, chars, rawChars, suspect, error, cached }) => ({ index, title, url, file, chars, rawChars, suspect, error, cached })),
  });
  writeFileSync(path.join(outDir, 'report.md'), renderReport(report), 'utf8');
  return { report, results };
}

function summarizeClean(stats) {
  const m = {};
  for (const s of stats) m[s.layer] = (m[s.layer] ?? 0) + s.count;
  return m;
}

function summarizeCleanStats(results) {
  const layers = {};
  for (const r of results) {
    if (!r.cleanedBy) continue;
    for (const [layer, n] of Object.entries(r.cleanedBy)) layers[layer] = (layers[layer] ?? 0) + n;
  }
  return layers;
}

function renderReport(r) {
  const lines = [
    `# 语料抓取报告：${r.book.name ?? '(未知书名)'}`,
    '',
    `- 书源：${r.source.name} (${r.source.url})`,
    `- 目录：${r.toc.realChapters} 章（卷标记 ${r.toc.volumes}，目录页 ${r.toc.pages}）`,
    `- 成功抓取：${r.fetched}；失败：${r.errors.length}；阻塞：${r.blocked ? `是（${r.blocked.at}）` : '否'}${r.stopped ? '；**手动停止：是**' : ''}`,
    `- 保真度：中位 ${r.fidelity.medianChars} 字，疑点阈值 ${r.fidelity.suspectThreshold}，**疑点 ${r.suspects} 章**（语义完整性需另行对账）`,
    `- 净化：${Object.entries(r.cleanupLayers).map(([k, v]) => `${k} ${v} 处`).join('、') || '无命中'}`,
    `- 警告：${r.warnings.length > 0 ? r.warnings.join('；') : '无'}`,
    `- 输出：${r.outDir}/manuscript/（每章 frontmatter 带溯源）`,
    `- 完成时间：${r.finishedAt}`,
  ];
  if (r.errors.length > 0) {
    lines.push('', '## 失败清单', ...r.errors.slice(0, 30).map((e) => `- [${e.index}] ${e.title}: ${e.error}`));
  }
  return lines.join('\n') + '\n';
}

function str(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length > 0 ? String(v[0]).trim() : null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
