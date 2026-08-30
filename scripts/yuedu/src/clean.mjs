/**
 * clean.mjs —— 三层净化机制的蒸馏（Legado「替换净化」的本地版）。
 *
 * 层1 书源净化：书源 ruleContent.replaceRegex / ruleBookInfo.replaceRegex
 *     格式（Legado 3.0）：JSON 字符串 {"old":"正则","new":"替换"} 或其数组；
 *     old 按 Java 正则（(?i) 内联标志转 JS）；非法正则回退为字面量替换。
 * 层2 用户净化：clean-rules.user.json（[{name, pattern, replacement, flags?}]），
 *     作者可增删——对应 Legado 替换净化 UI 的本地化。
 * 层3 内置默认：常见站方注入（广告/域名/提示语）与结构规整（空白折叠）。
 *
 * 纪律：每一层的删除量逐章计数并在报告透出（静默清洗 = 静默失真）。
 */

/** 内置默认净化模式（层数 3；按 2026 年中文小说站常见注入整理，可增）。 */
export const BUILTIN_RULES = [
  { name: '广告-一秒记住', pattern: '天才一秒记住本站地址.*', replacement: '' },
  { name: '广告-一秒记住2', pattern: '一秒记住[^。，\\n]{0,30}', replacement: '' },
  { name: '广告-记住书域名', pattern: '请记住本书首发域名[^。\\n]*', replacement: '' },
  { name: '广告-最新章节', pattern: '最新章节！?新\\S*笔趣\\S*|最新：?章节地址[:：]?\\S*', replacement: '' },
  { name: '广告-笔趣阁域名', pattern: '[\\w-]*笔趣阁?\\.?[\\w-]*\\.(com|cc|net|org|info|top|xyz|vip|la|mobi|us)\\S*', replacement: '' },
  { name: '广告-首发', pattern: '(本站|本书)?首发(自|于)?[\\w.-]+\\.(com|cc|net|org|top|xyz|vip)', replacement: '' },
  { name: '广告-访问提示', pattern: '(天才|瞬间|秒)之间?就可以?记住\\S*|手机(用户|版)?请访问\\S*|无弹窗\\S*广告\\S*', replacement: '' },
  { name: '广告-章节目录', pattern: '^章节目录\\s*', replacement: '' },
  { name: '广告-推荐语', pattern: '(求收藏|求推荐票|求月票|求订阅)[!！。～~]*\\s*', replacement: '' },
  { name: '广告-网址裸串', pattern: 'https?://\\S+\\.(com|net|cc|org|top|xyz|vip|info)[/\\S]*', replacement: '' },
  { name: '结构-网页锚文本', pattern: '\\[\\[\\[CP\\|[^\\]]*\\]\\]\\]|《?点击下一页[》》]?继续阅读[^。\\n]*', replacement: '' },
];

/** 解析书源 replaceRegex 字段（对象 / 数组 / 非法→字面量兜底）。 */
export function parseReplaceRegex(field) {
  if (!field || typeof field !== 'string') return [];
  const rules = [];
  let parsed;
  try {
    parsed = JSON.parse(field);
  } catch {
    // 兜底：把整段当 {"old":...} 失败时按单条字面量处理
    return [{ name: '书源净化(字面量)', pattern: escapeLiteral(field), replacement: '' }];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { old: oldV, new: newV } = item;
    if (typeof oldV !== 'string') continue;
    rules.push({ name: '书源净化', pattern: oldV, replacement: typeof newV === 'string' ? newV : '' });
  }
  return rules;
}

function escapeLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(pattern, flags) {
  try {
    let f = flags ?? 'g';
    const m = /^\(\?([a-z]+)\)/.exec(pattern);
    let p = pattern;
    if (m) {
      f += m[1].includes('i') ? 'i' : '';
      p = p.slice(m[0].length);
    }
    return { re: new RegExp(p, f.includes('g') ? f : f + 'g'), err: null };
  } catch {
    // Java/JS 方言差异兜底：按字面量
    try {
      return { re: new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), (flags ?? '') + 'g'), err: 'literal' };
    } catch (err2) {
      return { re: null, err: err2.message };
    }
  }
}

/**
 * 规则表（Legado 替换净化同款语义，0830 补齐）：用户规则可带 enabled:false 停用；
 * 内置规则可按名停用（表对象 disabledBuiltin 数组）。文件两种形态都收：
 *   旧：[ {name,pattern,replacement,flags?}, … ]
 *   新：{ rules: […同上含 enabled?], disabledBuiltin: [内置规则名,…] }
 */
function normalizeTable(t) {
  if (Array.isArray(t)) return { rules: t, disabledBuiltin: [] };
  if (t && typeof t === 'object') {
    return {
      rules: Array.isArray(t.rules) ? t.rules : [],
      disabledBuiltin: Array.isArray(t.disabledBuiltin) ? t.disabledBuiltin.filter((x) => typeof x === 'string') : [],
    };
  }
  return { rules: [], disabledBuiltin: [] };
}

/**
 * 对一章正文跑三层净化。
 * @param {string} text 原始正文（已从 HTML 提取）
 * @param {object} p { sourceRules: [{pattern,replacement}], userRules: Array|{rules,disabledBuiltin}, builtin: boolean }
 * @returns {{ text, stats: Array<{layer,name,count,flagged?}> }}
 */
export function cleanContent(text, p = {}) {
  const table = normalizeTable(p.userRules);
  const stats = [];
  let cur = text;
  const apply = (layerName, rules) => {
    for (const r of rules) {
      if (r.enabled === false) continue; // 规则表勾选语义：停用规则跳过但保留在表中
      const { re, err } = compile(r.pattern, r.flags);
      if (!re) {
        stats.push({ layer: layerName, name: r.name ?? r.pattern.slice(0, 30), count: 0, flagged: `正则非法: ${err}` });
        continue;
      }
      let count = 0;
      cur = cur.replace(re, (...args) => {
        count += 1;
        return typeof r.replacement === 'string' ? r.replacement.replace(/\$(\d)/g, (m2, d) => args[Number(d)] ?? m2) : '';
      });
      if (count > 0) stats.push({ layer: layerName, name: r.name ?? r.pattern.slice(0, 30), count });
    }
  };

  apply('书源', p.sourceRules ?? []);
  apply('用户', table.rules);
  if (p.builtin !== false) apply('内置', BUILTIN_RULES.filter((r) => !table.disabledBuiltin.includes(r.name)));

  // 结构规整：行内空白折叠、三连空行压双、行尾空白；不删段间空行之外的任何内容
  const before = cur.length;
  cur = cur
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0\u3000]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (before !== cur.length) stats.push({ layer: '结构', name: '空白规整', count: 1 });

  return { text: cur, stats };
}

/** 段落输出为 markdown 正文（章文件用）：段落间空行。 */
export function toParagraphs(text) {
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n\n');
}
