/**
 * source.mjs —— 书源加载与 validate（蒸馏 Legado 书源管理的本地版）。
 *
 * validate 产出：每源可用性画像——
 *   - 引擎用量统计（default/css/json/regexAllInOne/xpath/js）
 *   - 不支持项清单（xpath/js/webView/webJs/sourceRegex/loginUrl/发现页）
 *   - 结论：full | partial(列明缺失) | unusable
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export function loadSourceFile(p) {
  if (!existsSync(p)) throw new Error(`书源文件不存在: ${p}`);
  const raw = readFileSync(p, 'utf8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : [data];
  return list.filter((s) => s && typeof s === 'object' && s.bookSourceUrl);
}

export function loadSourcesDir(dir) {
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      out.push(...loadSourceFile(path.join(dir, f)));
    } catch (err) {
      console.warn(`[yuedu] 书源文件解析失败，跳过: ${f}（${err.message}）`);
    }
  }
  return out;
}

/** 找书源：先精确/包含匹配 bookSourceName，再匹配 bookSourceUrl，再按下标。 */
export function pickSource(sources, key) {
  if (/^\d+$/.test(key)) {
    const i = parseInt(key, 10);
    if (i >= 0 && i < sources.length) return sources[i];
  }
  const byName = sources.filter((s) => (s.bookSourceName ?? '').includes(key));
  if (byName.length > 0) return byName[0];
  const byUrl = sources.find((s) => (s.bookSourceUrl ?? '').includes(key));
  if (byUrl) return byUrl;
  throw new Error(`找不到书源: ${key}（可用 ${sources.length} 个，用 sources list 查看）`);
}

const RULE_FIELDS = {
  ruleSearch: ['bookList', 'name', 'author', 'bookUrl', 'coverUrl', 'kind', 'wordCount', 'lastChapter', 'intro'],
  ruleBookInfo: ['name', 'author', 'kind', 'wordCount', 'lastChapter', 'intro', 'coverUrl', 'tocUrl'],
  ruleToc: ['chapterList', 'chapterName', 'chapterUrl', 'isVolume', 'updateTime', 'nextTocUrl'],
  ruleContent: ['content', 'nextContentUrl', 'replaceRegex'],
};

/** 扫描一条规则串用的引擎/特性（validate 用，不求值）。 */
function scanRule(rule, acc) {
  if (!rule || typeof rule !== 'string') return;
  const t = rule.trim();
  if (t === '') return;
  if (t.startsWith('@js:') || t.includes('<js>')) acc.js += 1;
  else if (t.startsWith('@XPath:') || t.startsWith('//')) acc.xpath += 1;
  else if (t.startsWith('@json:') || t.startsWith('$')) acc.json += 1;
  else if (t.startsWith('@css:') || t.startsWith('@CSS:')) acc.css += 1;
  else if (t.startsWith(':')) acc.regexList += 1;
  else acc.def += 1;
  if (t.includes('@get') || t.includes('@put')) acc.vars += 1;
  if (t.includes('%%')) acc.intersection += 1;
  if (t.includes('{{') && !/{{\s*(@@|@json:|@css:|\$|:)/.test(t) && !/{{\s*(key|page)\s*\}\}/.test(t)) acc.jsTpl += 1;
}

export function validateSource(source) {
  const acc = { def: 0, css: 0, json: 0, xpath: 0, js: 0, regexList: 0, vars: 0, jsTpl: 0, intersection: 0 };
  const missing = [];
  const unsupported = [];
  for (const [group, fields] of Object.entries(RULE_FIELDS)) {
    const g = source[group] ?? {};
    for (const f of fields) {
      const rule = g[f] ?? '';
      if (!String(rule).trim()) {
        // content 与 chapterList/chapterName/chapterUrl/bookList 必需
        if ((group === 'ruleContent' && f === 'content')
          || (group === 'ruleToc' && ['chapterList', 'chapterName', 'chapterUrl'].includes(f))
          || (group === 'ruleSearch' && ['bookList', 'name', 'bookUrl'].includes(f))) {
          missing.push(`${group}.${f}`);
        }
        continue;
      }
      scanRule(rule, acc);
    }
  }
  for (const u of ['searchUrl', ...(source.exploreUrl ? ['exploreUrl'] : [])]) {
    scanRule(source[u] ?? '', acc);
  }
  if (acc.xpath > 0) unsupported.push(`XPath 规则 ×${acc.xpath}`);
  if (acc.js > 0 || acc.jsTpl > 0) unsupported.push(`JS 规则/模板 ×${acc.js + acc.jsTpl}`);
  if (acc.vars > 0) unsupported.push(`@get/@put 变量 ×${acc.vars}`);
  if (acc.intersection > 0) unsupported.push(`%% 交集 ×${acc.intersection}`);
  if (source.ruleContent?.webJs || source.ruleContent?.sourceRegex) unsupported.push('webJs/sourceRegex（嗅探）');
  if (/<,\s*\{\s*"webView"/.test(source.searchUrl ?? '') || (source.ruleContent?.content ?? '').includes('webView')) {
    unsupported.push('webView 加载');
  }
  const notes = [];
  if (source.loginUrl) notes.push('书源声明登录页（可经 --cookie 注入登录态）');
  if (source.enabledCookieJar) notes.push('启用 CookieJar');
  if ((source.bookSourceType ?? 0) !== 0 && (source.bookSourceType ?? '0') !== '0') notes.push(`非文本源(type=${source.bookSourceType})`);
  const requiredMissing = missing.length > 0;
  const verdict = requiredMissing
    ? 'unusable'
    : unsupported.length === 0
      ? 'full'
      : unsupported.some((u) => u.includes('正文') || u.includes('chapterList') || u.includes('bookList')) ? 'unusable' : 'partial';
  return {
    name: source.bookSourceName ?? '(未命名)',
    url: source.bookSourceUrl,
    group: source.bookSourceGroup ?? '',
    engines: acc,
    missing,
    unsupported,
    notes,
    verdict,
  };
}
