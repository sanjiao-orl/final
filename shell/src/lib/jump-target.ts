/**
 * jump-target.ts —— T9 壳层正文跳转协议（质检/审阅/对账/账本四类结果面板 → 编辑器定位）。
 *
 * 行号口径（全局统一）：外部来源（scan_quality 命中、质检 finding、账本证据锚、对账定位）
 * 的 line 一律是「文件 1 起始行号，含 frontmatter 行」（与 domain locateQuoteLine/search_content
 * 同口径）。编辑器正文不含 frontmatter，跳转前须用 frontmatterLineCount 换算成正文行号。
 *
 * 本文件只放纯函数（可单测）；Editor.svelte 负责 PM 文档定位与滚动/高亮副作用。
 */

/** 跳转目标：quote 优先精确定位；line 兜底（行号漂移是编辑常态，允许近似）。 */
export interface JumpTarget {
  /** 文件 1 起始行号（含 frontmatter 行）。 */
  line?: number;
  /** 原文引用（逐字摘录，可能截断）。 */
  quote?: string;
}

/**
 * frontmatter 行数：原样保留的 fm 文本块以换行结尾，其行数 = split(/\r?\n/).length - 1
 * （与 core/src/qualityCheck.ts 的 frontmatterLineOffset 同口径）；空串 → 0。
 */
export function frontmatterLineCount(frontmatterRaw: string): number {
  if (frontmatterRaw === '') return 0;
  return frontmatterRaw.split(/\r?\n/).length - 1;
}

/** 文件行号（含 frontmatter）→ 正文 1 起始行号；换算后 < 1（落在 frontmatter 内）→ null。 */
export function bodyLineForFileLine(fileLine: number, frontmatterRaw: string): number | null {
  const body = fileLine - frontmatterLineCount(frontmatterRaw);
  return body < 1 ? null : body;
}

/**
 * 正文 md 中第 bodyLine 行的目标文本（1 起始）：越界 → null；
 * 该行是空白行则向上贴最近非空行（到顶仍空 → null）；
 * 剥掉 md 标题前缀后 trim 返回（PM 块文本不含 '#'，便于 includes 校验）。
 */
export function targetLineText(md: string, bodyLine: number): string | null {
  if (bodyLine < 1) return null;
  const lines = md.split(/\r?\n/);
  let i = bodyLine - 1;
  if (i >= lines.length) return null;
  while (i >= 0 && lines[i]!.trim() === '') i--; // 空白行向上贴最近非空行
  if (i < 0) return null; // 到顶仍全空
  return lines[i]!.replace(/^#{1,6}\s+/, '').trim();
}

/**
 * 目标行（经 targetLineText 同款空白贴靠）在「正文非空行序列」里的 0 基下标（= 之前的非空行数）；
 * 无有效行 → -1。该下标是 PM 顶层 textblock 的估算位（md 非空行与 PM 顶层 textblock 通常一一对应；
 * 无空行分隔的连续行会被 markdown 合并成一个块，调用方须用文本校验纠偏）。
 */
export function estimateBlockIndex(md: string, bodyLine: number): number {
  if (bodyLine < 1) return -1;
  const lines = md.split(/\r?\n/);
  let i = bodyLine - 1;
  if (i >= lines.length) return -1;
  while (i >= 0 && lines[i]!.trim() === '') i--;
  if (i < 0) return -1;
  let count = 0;
  for (let k = 0; k < i; k++) {
    if (lines[k]!.trim() !== '') count++;
  }
  return count;
}
