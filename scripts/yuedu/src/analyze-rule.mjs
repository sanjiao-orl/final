/**
 * analyze-rule.mjs —— Legado 3.0 规则引擎的本地蒸馏（v1 子集）。
 *
 * 支持（覆盖现代书源的大多数形态，规格出处 docs/source-tutorial.txt）：
 *   - 默认规则：@ 分段；class./id./tag./text. 选择器 + 可选位置；children；
 *     [0]/[-1]/[0:3]/[!0]/[a,b] 索引；首段裸索引 = children+索引；末段取值
 *     text/textNodes/ownText/html/all/任意属性（href/src 自动补全相对 URL）
 *   - @css: 前缀（cheerio 实现）
 *   - @json: / $. 前缀 JSONPath（jsonpath-plus）；JSON 上下文裸属性路径；
 *     AllInOne 组上下文的 $1/$2 引用
 *   - :AllInOne 正则列表（捕获组 → 组上下文）；##re##rep### OnlyOne 首匹配
 *   - ##正则##替换 尾缀（循环替换）；|| 回退 / && 合并（\n 连接）
 *   - {{@json:$.x}} / {{@@默认}} / {{@css:...}} 模板与 {$.x} 内联
 * 不支持（显式报错，不做静默错取）：
 *   - @js: / <js></js> / 无标志 {{js}}；@XPath: / // 开头；@get/@put；%% 交集
 *
 * 上下文：{type:'html', $, els, baseUrl} 或 {type:'json', json, baseUrl}
 */
import * as cheerio from 'cheerio';
import { JSONPath } from 'jsonpath-plus';
import { splitByOperators, splitRegexTail } from './rule-tokenizer.mjs';

/** 不支持/非法规则错误：带规则原文，供书源 validate 汇总。 */
export class RuleUnsupportedError extends Error {
  constructor(message, rule) {
    super(`${message}（规则: ${rule}）`);
    this.name = 'RuleUnsupportedError';
    this.rule = rule;
  }
}

const GETTERS = new Set(['text', 'textNodes', 'ownText', 'html', 'all', 'href', 'src', 'content', 'value']);

/**
 * 评估一条规则。字段规则期望字符串；列表规则传 allowList:true 允许返回元素/JSON 数组。
 */
export function evaluateRule(rule, ctx, opts = {}) {
  if (!rule || !rule.trim()) return null;
  const parts = splitByOperators(rule.trim());
  let acc = evalPart(parts[0], ctx, opts);
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].op === '%%') throw new RuleUnsupportedError('%% 交集 v1 不支持', parts[i].text);
    const v = evalPart(parts[i], ctx, opts);
    if (parts[i].op === '&&') {
      acc = joinValues(acc, v);
    } else {
      // || 回退：左侧空取右侧
      acc = nonEmpty(acc) ? acc : v;
    }
  }
  return acc;
}

function evalPart(part, ctx, opts) {
  const { body, match, replace, onlyOne, hasRegex } = splitRegexTail(part.text);
  let result;
  if (body.trim() === '') {
    if (!hasRegex) return null;
    // 无规则体：OnlyOne = 全文首个匹配整体替换；净化形态 = 全文循环替换
    const src = opts.source ?? '';
    return onlyOne ? regexFirst(src, match, replace) : regexApply(src, match, replace, true);
  }
  if (onlyOne) {
    // 有规则体的 OnlyOne（罕见）：先求值再对结果做首匹配替换
    const v = evaluateBody(body, ctx, opts);
    return v == null ? null : regexFirst(String(v), match, replace);
  }
  result = evaluateBody(body, ctx, opts);
  if (hasRegex && result != null) {
    result = mapStrings(result, (s) => regexApply(s, match, replace, true));
  }
  return result;
}

function nonEmpty(v) {
  return Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== '';
}

function joinValues(a, b) {
  const fa = a == null ? [] : Array.isArray(a) ? a : [String(a)];
  const fb = b == null ? [] : Array.isArray(b) ? b : [String(b)];
  const joined = [...fa, ...fb].filter((x) => x !== '' && x != null);
  return joined.length === 0 ? null : joined.join('\n');
}

function mapStrings(v, fn) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? fn(x) : x));
  return typeof v === 'string' ? fn(v) : v;
}

/** 规则体引擎分发。 */
function evaluateBody(body, ctx, opts) {
  const allowList = opts.allowList ?? false;
  if (body.startsWith('@js:') || body.includes('<js>')) {
    throw new RuleUnsupportedError('JS 规则 v1 不支持', body);
  }
  if (body.startsWith('@XPath:') || body.startsWith('//')) {
    throw new RuleUnsupportedError('XPath 规则 v1 不支持', body);
  }
  if (body.startsWith('@json:') || body.startsWith('$.') || body.startsWith('$[') || body.startsWith('$..')) {
    return evalJsonPath(stripPrefix(body, ['@json:']), ctx);
  }
  if (body.startsWith(':')) return evalAllInOne(body.slice(1), ctx, opts);
  if (body.startsWith('@css:') || body.startsWith('@CSS:')) {
    return evalDefault(body.replace(/^@css:/i, '').trim(), ctx, { allowList, engine: 'css' });
  }
  if (body.startsWith('@@')) return evalDefault(body.slice(2).trim(), ctx, { allowList });
  return evalDefault(body, ctx, { allowList });
}

function stripPrefix(s, prefixes) {
  for (const p of prefixes) if (s.startsWith(p)) return s.slice(p.length).trim();
  return s;
}

// ---------- JSONPath ----------

function evalJsonPath(path, ctx) {
  if (ctx.type === 'jsonGroups') {
    // AllInOne 组上下文：$1/$2 引用捕获组
    if (/^\$\d+$/.test(path)) return ctx.json[path] ?? null;
  }
  if (ctx.type !== 'json' && ctx.type !== 'jsonGroups') {
    throw new RuleUnsupportedError('JSONPath 规则用在 HTML 上下文（v1 不跨态求值）', path);
  }
  const normalized = path.replace(/\.\[\*/g, '[*]');
  let out;
  try {
    out = JSONPath({ path: normalized, json: ctx.json, wrap: true });
  } catch (err) {
    throw new RuleUnsupportedError(`JSONPath 求值失败: ${err.message}`, path);
  }
  if (!Array.isArray(out)) return out ?? null;
  if (out.length === 0) return null;
  return out.length === 1 ? out[0] : out;
}

// ---------- 正则 ----------

/** Java 正则 → JS（处理 (?i) 内联标志；非法时按字面量兜底并带原因）。 */
function toJsRegex(pattern, global) {
  let flags = global ? 'g' : '';
  let p = pattern;
  const m = /^\(\?([a-z]+)\)/.exec(p);
  if (m) {
    if (m[1].includes('i')) flags += 'i';
    if (m[1].includes('s')) flags += 's';
    p = p.slice(m[0].length);
  }
  try {
    return { re: new RegExp(p, flags), err: null };
  } catch (err) {
    try {
      return { re: new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags), err: err.message };
    } catch (err2) {
      return { re: null, err: err2.message };
    }
  }
}

function regexApply(text, match, replace, global) {
  const { re, err } = toJsRegex(match, global);
  if (!re) throw new RuleUnsupportedError(`正则非法(${err}): ${match}`, match);
  return text.replace(re, replace ?? '');
}

/** OnlyOne：取全文首个匹配，对命中串做替换（替换为空时原样返回命中串）；无匹配返回 null。 */
function regexFirst(text, match, replace) {
  const { re, err } = toJsRegex(match, true);
  if (!re) throw new RuleUnsupportedError(`正则非法(${err}): ${match}`, match);
  const m = re.exec(text);
  if (!m) return null;
  const hit = m[0];
  if (!replace) return hit;
  const local = toJsRegex(match, false).re;
  return local ? hit.replace(local, replace) : hit;
}

// ---------- AllInOne 正则列表 ----------

function evalAllInOne(pattern, ctx, opts) {
  const src = opts.source ?? '';
  const { re, err } = toJsRegex(pattern, true);
  if (!re) throw new RuleUnsupportedError(`AllInOne 正则非法(${err}): ${pattern}`, pattern);
  const rows = [];
  for (const m of src.matchAll(re)) {
    const groups = { $0: m[0] };
    for (let g = 1; g < m.length; g++) groups[`$${g}`] = m[g] ?? '';
    rows.push(groups);
  }
  return opts.allowList === false && rows.length > 0 ? rows[0] : rows;
}

// ---------- 默认 / CSS 规则（HTML 上下文） ----------

function evalDefault(rule, ctx, opts = {}) {
  if (ctx.type === 'json' || ctx.type === 'jsonGroups') return evalDefaultOnJson(rule, ctx);
  const { $, els, baseUrl } = ctx;
  let current = els ?? null; // null = 根文档
  const segs = parseSegments(rule, opts.engine ?? 'default');
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    const isLast = si === segs.length - 1;
    if (seg.kind === 'index') {
      current = applyIndex(current ?? [], seg.spec);
      continue;
    }
    if (seg.kind === 'getter') {
      return applyGetter($, current ?? [], seg, baseUrl);
    }
    current = applySelector($, current, seg);
    if (opts.allowList && isLast) return current;
  }
  // allowList 规则以索引/children 结尾（无取值段）：返回元素集
  if (opts.allowList && current != null) return current;
  // 无取值段：默认 text（列表规则不会走到这里——allowList 已在最后选择段返回）
  return applyGetter($, current ?? [], { name: 'text' }, baseUrl);
}

/** 解析默认规则为段序列。engine='css' 时各段（除取值外）为整段 CSS 选择器。 */
function parseSegments(rule, engine = 'default') {
  const segs = [];
  for (const raw of rule.split('@')) {
    const seg = raw.trim();
    if (seg === '') continue;
    if (engine === 'css') {
      segs.push(GETTERS.has(seg) ? { kind: 'getter', name: seg } : { kind: 'css', css: seg });
      continue;
    }
    if (/^\[.*\]$/.test(seg) || /^\.?\d+$/.test(seg)) {
      segs.push({ kind: 'index', spec: seg.replace(/^\[|\]$/g, '').replace(/^\./, '') });
      continue;
    }
    if (seg === 'children') {
      segs.push({ kind: 'children' });
      continue;
    }
    const sel = /^(class|id|tag|text)\.([^.[\]]+?)(?:\.(\S+))?$/.exec(seg);
    if (sel) {
      segs.push({ kind: 'selector', type: sel[1], name: sel[2], index: sel[3] ?? null });
      continue;
    }
    // 裸 CSS 选择器：真实书源常见形态——.class / #id / tag.class / tag#id / 含空格组合（h4 a）。
    // 尾部 .N 是默认语法索引（.face-info span.0 → .face-info span 取第 0 个），不是类名的一部分。
    if (seg.startsWith('.') || seg.startsWith('#') || /\s/.test(seg) || /^[a-zA-Z][\w-]*[.#[]/.test(seg)) {
      const m = /^(.*\S)\.(\d+)$/.exec(seg);
      if (m) segs.push({ kind: 'css', css: m[1], index: m[2] });
      else segs.push({ kind: 'css', css: seg, index: null });
      continue;
    }
    // 裸标签 + 排除/索引后缀（如 li!0、div[0]）：tag 选择器 + 索引段
    const tagIdx = /^([a-zA-Z][\w-]*)(![\d:, -]+|\[[^\]]+\])$/.exec(seg);
    if (tagIdx) {
      segs.push({ kind: 'selector', type: 'tag', name: tagIdx[1], index: null });
      const spec = tagIdx[2].startsWith('[') ? tagIdx[2].slice(1, -1) : tagIdx[2];
      segs.push({ kind: 'index', spec });
      continue;
    }
    // 其余裸标识 = 取值段（text/href/data-src/og:image 等）
    segs.push({ kind: 'getter', name: seg });
  }
  return segs;
}

/** 规格化下标：负数从尾部数。 */
function normIndex(i, len) {
  return i < 0 ? len + i : i;
}

/** 对元素数组应用索引规格：N、[a,b]、[!x:y]、[s:e:step]（支持负数与反向）。 */
function applyIndex(els, specIn) {
  const spec = String(specIn).trim();
  const arr = Array.isArray(els) ? els : [...els];
  if (spec.startsWith('!')) {
    const banned = new Set(
      spec.slice(1).split(':').map((x) => normIndex(parseInt(x, 10), arr.length)).filter((x) => x >= 0),
    );
    return arr.filter((_, i) => !banned.has(i));
  }
  if (spec.includes(',')) {
    return spec.split(',').map((x) => {
      const i = normIndex(parseInt(x, 10), arr.length);
      return i >= 0 && i < arr.length ? arr[i] : null;
    }).filter(Boolean);
  }
  if (spec.includes(':')) {
    const [a, b, step] = spec.split(':');
    const ai = a === '' ? 0 : parseInt(a, 10);
    const bi = b === '' || b === undefined ? arr.length : parseInt(b, 10);
    const st = step ? Math.abs(parseInt(step, 10)) : 1;
    if (ai > bi) {
      // 反向区间 [-1:0]：end..start 双端含、倒序（Legado 列表反向特例）
      const hi = normIndex(ai, arr.length);
      const lo = normIndex(bi, arr.length);
      const out = [];
      for (let i = hi; i >= lo; i--) if (arr[i] !== undefined) out.push(arr[i]);
      return out;
    }
    // 常规切片：排他 end（同 JS slice）
    const out = [];
    for (let i = normIndex(ai, arr.length); i < Math.min(normIndex(bi, arr.length), arr.length); i += st) {
      out.push(arr[i]);
    }
    return out;
  }
  const idx = normIndex(parseInt(spec, 10), arr.length);
  return idx >= 0 && idx < arr.length ? [arr[idx]] : [];
}

/** 应用一个选择段（current=null 表示根文档）。返回普通元素数组。 */
function applySelector($, current, seg) {
  if (seg.kind === 'css') {
    const found = selectAll($, current, seg.css);
    return seg.index != null ? applyIndex(found, seg.index) : found;
  }
  const css = selectorToCss(seg);
  if (seg.index != null) {
    const found = selectAll($, current, css);
    return applyIndex(found, seg.index);
  }
  return selectAll($, current, css);
}

function selectAll($, current, css) {
  if (!current) return $(css).toArray();
  const out = [];
  for (const el of current) out.push(...$(css, el).toArray());
  return out;
}

function selectorToCss(seg) {
  switch (seg.type) {
    case 'class': return `.${seg.name}`;
    case 'id': return `#${seg.name}`;
    case 'tag': return seg.name.toLowerCase();
    case 'text': return `:contains("${seg.name}")`;
    default: throw new RuleUnsupportedError(`未知选择器类型: ${seg.type}`, `${seg.type}.${seg.name}`);
  }
}

// ---------- 取值 ----------

function applyGetter($, els, seg, baseUrl) {
  if (els.length === 0) return null;
  const name = seg.name;
  // URL 类字段对多元素取首值并补全相对路径
  if (name === 'href' || name === 'src') {
    return absUrl($, els[0], name, baseUrl);
  }
  const el = els[0];
  switch (name) {
    case 'text':
      return $(el).text().trim();
    case 'textNodes': {
      const parts = [];
      const walk = (node) => {
        for (const child of $(node).contents().toArray()) {
          if (child.type === 'text') {
            const t = String(child.data ?? '').replace(/\s+/g, ' ').trim();
            if (t) parts.push(t);
          } else if (child.type === 'tag' && !['script', 'style', 'noscript'].includes(child.tagName)) {
            walk(child);
          }
        }
      };
      walk(el);
      return parts.join('\n').trim();
    }
    case 'ownText': {
      const parts = [];
      for (const child of $(el).contents().toArray()) {
        if (child.type === 'text') {
          const t = String(child.data ?? '').replace(/\s+/g, ' ').trim();
          if (t) parts.push(t);
        }
      }
      return parts.join(' ').trim();
    }
    case 'html':
      return $(el).html() ?? '';
    case 'all':
      return $.html(el);
    default:
      // content/value/任意属性名
      return $(el).attr(name) ?? null;
  }
}

function absUrl($, el, attr, baseUrl) {
  const raw = $(el).attr(attr);
  if (!raw) return null;
  try {
    return new URL(raw, baseUrl || undefined).href;
  } catch {
    return raw;
  }
}

// ---------- JSON 上下文的默认规则（裸属性路径） ----------

function evalDefaultOnJson(rule, ctx) {
  const r = rule.trim();
  if (ctx.type === 'jsonGroups' && /^\$\d+$/.test(r)) return ctx.json[r] ?? null;
  if (r === 'text') return JSON.stringify(ctx.json);
  if (GETTERS.has(r)) {
    const v = ctx.json?.[r] ?? ctx.json?.[`${r}Url`];
    return v == null ? null : String(v);
  }
  if (r.startsWith('@')) return evalDefaultOnJson(r.replace(/^@+/, ''), ctx);
  const v = jsonProp(ctx.json, r);
  return v == null ? null : typeof v === 'string' ? v : JSON.stringify(v);
}

function jsonProp(value, prop) {
  let cur = value;
  for (const seg of prop.split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// ---------- 模板：{{...}} 与 {$.x} ----------

/**
 * 字段值模板展开：{{@json:$.x}} / {{@@seg}} / {{@css:...}}；{$.x}（2.0 遗留内联）。
 * 无标志 {{...}} 视为 js → v1 不支持（经 opts.onUnsupported 告警后返回空）。
 * searchUrl 的 {{key}}/{{page}} 不在此处理（AnalyzeUrl 负责）。
 */
export function expandTemplates(text, ctx, opts = {}) {
  if (!text || !text.includes('{{')) return text;
  const warn = opts.onUnsupported ?? (() => {});
  return text
    .replace(/\{\{([^{}]+)\}\}/g, (_, inner) => {
      const t = inner.trim();
      if (/^(js|@js:)/i.test(t)) {
        warn(`模板需 JS（v1 不支持）: {{${t}}}`);
        return '';
      }
      try {
        const v = evaluateRule(t, ctx, opts);
        return v == null ? '' : String(Array.isArray(v) ? v.join(',') : v);
      } catch (err) {
        if (err instanceof RuleUnsupportedError) {
          warn(`{{${t}}} → ${err.message}`);
          return '';
        }
        throw err;
      }
    })
    .replace(/\{(\$[^{}]+)\}/g, (_, jp) => {
      try {
        const v = evalJsonPath(jp.trim(), ctx);
        return v == null ? '' : String(v);
      } catch (err) {
        warn(`{${jp}} → ${err.message}`);
        return '';
      }
    });
}
