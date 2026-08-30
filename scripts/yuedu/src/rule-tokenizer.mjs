/**
 * rule-tokenizer.mjs —— Legado 规则串的顶层分词。
 *
 * 难点：`||`/`&&`/`%%` 是连接符，但它们可能出现在 `##正则##替换` 的正则体里
 * （如 @css:...@textNodes##搜索.*手机访问|一秒记住.*）。Legado 的 RuleAnalyzer
 * 用状态机解决：遇到未转义的 `##` 进入正则态，直到下一个未转义 `##` 才退出。
 * 本模块实现同款状态机：
 *   - 返回顶层段列表 [{ op: 'root'|'||'|'&&'|'%%', text }]
 *   - 每段内再由 analyzeRule 按 `##` 切出 规则/匹配/替换 三部分
 */

/**
 * 按顶层连接符切分规则串（正则态内不切分）。
 * @param {string} rule
 * @returns {Array<{op: string, text: string}>} op ∈ root | || | && | %%
 */
export function splitByOperators(rule) {
  const parts = [];
  let buf = '';
  let pendingOp = 'root'; // 下一段与上一段之间的连接符
  let i = 0;
  let inRegex = false; // 正则态：处于 ## 与 ## 之间
  let regexSection = 0; // 本段内已遇到的 ## 次数（最多 2 个：匹配、替换）
  while (i < rule.length) {
    const two = rule.slice(i, i + 2);
    if (!inRegex && two === '||') {
      parts.push({ op: pendingOp, text: buf });
      buf = '';
      pendingOp = '||';
      i += 2;
      continue;
    }
    if (!inRegex && two === '&&') {
      parts.push({ op: pendingOp, text: buf });
      buf = '';
      pendingOp = '&&';
      i += 2;
      continue;
    }
    if (!inRegex && two === '%%') {
      parts.push({ op: pendingOp, text: buf });
      buf = '';
      pendingOp = '%%';
      i += 2;
      continue;
    }
    if (two === '##') {
      // 进入/退出正则态：##匹配##替换 共两个 ##，第二个闭合替换节（### OnlyOne 的第三个 ## 会再次进入，无内容即无影响）
      inRegex = !inRegex;
      buf += two;
      i += 2;
      continue;
    }
    // 反斜杠转义：原样带走下一个字符（如 \#\# 或正则里的 \d 等不特判）
    if (rule[i] === '\\' && i + 1 < rule.length) {
      buf += rule[i] + rule[i + 1];
      i += 2;
      continue;
    }
    buf += rule[i];
    i += 1;
  }
  parts.push({ op: pendingOp, text: buf });
  return parts;
}

/**
 * 把单段规则切为 { body, match, replace, onlyOne }：
 *   body##match##replace   净化（循环替换，replace 可省略）
 *   ##match##replace###    OnlyOne（只取第一个匹配；规则体为空 = 全文做正则）
 * @param {string} segment 已按顶层连接符切出的单段
 */
export function splitRegexTail(segment) {
  // OnlyOne：## 开头且 ### 结尾
  if (segment.startsWith('##')) {
    const inner = segment.slice(2);
    const onlyOne = inner.endsWith('###');
    const core = onlyOne ? inner.slice(0, -3) : inner;
    const parts = splitUnescaped(core, '##');
    return {
      body: '',
      match: parts[0] ?? '',
      replace: parts[1] ?? '',
      onlyOne,
      hasRegex: true,
    };
  }
  // 净化：规则体后跟 ##匹配[##替换]
  const parts = splitUnescaped(segment, '##');
  if (parts.length >= 2) {
    return {
      body: parts[0],
      match: parts[1] ?? '',
      replace: parts[2] ?? '',
      onlyOne: false,
      hasRegex: true,
    };
  }
  return { body: segment, match: '', replace: '', onlyOne: false, hasRegex: false };
}

/** 按未转义分隔符切分（\## 不算分隔）。 */
function splitUnescaped(str, sep) {
  const out = [];
  let buf = '';
  let i = 0;
  while (i < str.length) {
    if (str.startsWith(sep, i) && str[i - 1] !== '\\') {
      out.push(buf);
      buf = '';
      i += sep.length;
      continue;
    }
    buf += str[i];
    i += 1;
  }
  out.push(buf);
  return out;
}
