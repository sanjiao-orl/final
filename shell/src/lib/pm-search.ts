/**
 * pm-search.ts —— ProseMirror 文档纯文本定位：把扁平文档（段落/标题块）拼成单串文本搜索，
 * 再把命中偏移映射回 PM 位置。候选锚定（original ↔ 正文范围）全靠它。
 *
 * 拼接约定：块间恰好一个 '\n'；hard_break 渲染为 '\n'（leafText）。
 * 选区捕获必须用同一约定：captureSelection = doc.textBetween(from, to, '\n', '\n')。
 */
import type { Node as PMNode } from '@tiptap/pm/model';

export interface TextRange {
  from: number;
  to: number;
}

interface Block {
  /** 块文本在 PM 文档中的起始位置（节点起始 pos + 1）。 */
  start: number;
  /** 块内文本（hard_break 已渲染为 '\n'）。 */
  text: string;
}

/** 扁平文档假设：只取 textblock（paragraph/heading），不深入嵌套容器。 */
function textBlocks(doc: PMNode): Block[] {
  const blocks: Block[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      blocks.push({ start: pos + 1, text: node.textBetween(0, node.content.size, '', '\n') });
      return false;
    }
    return true;
  });
  return blocks;
}

/** 整文档纯文本（与 captureSelection 同约定）。 */
export function docText(doc: PMNode): string {
  return textBlocks(doc)
    .map((b) => b.text)
    .join('\n');
}

/**
 * 捕获选区文本（创建候选时的 original）。
 * 与 docText 同一约定：只收集 textblock 文本、块间恰好一个 '\n'；
 * 块级 leaf（hr 等）跳过不产出额外分隔符——跨 hr 的选区文本在 docText 里必然可回找。
 */
export function captureSelection(doc: PMNode, from: number, to: number): string {
  const parts: string[] = [];
  for (const b of textBlocks(doc)) {
    const bFrom = Math.max(from, b.start);
    const bTo = Math.min(to, b.start + b.text.length);
    if (bFrom >= bTo) continue;
    const seg = doc.textBetween(bFrom, bTo, '', '\n');
    if (seg !== '') parts.push(seg);
  }
  return parts.join('\n');
}

/**
 * 全文搜索 needle，返回全部命中的 PM 范围（可能 0/1/N 个）。
 * 块间 '\n' 占拼接串 1 字符，对应 PM 里块间隙整体（2 个位置：前块闭合+后块开启）。
 * 两过匹配（D7「跨行 quote 定位必失配」）：先精确 indexOf（命中即返回，行为不变）；
 * 未中再紧凑兜底——双侧剥全部空白（\s 含 \u00a0/\u3000，换行一并剥去）后匹配，
 * 源文件摘录的 needle（带 \r\n 或段间 \n\n）在块间单 '\n' 的拼接串里原本必失配，紧凑后可命中；
 * 命中偏移经「紧凑偏移→拼接串偏移」映射回 PM 位置。全空白 needle 紧凑后为空串，不兜底。
 */
export function findTextRanges(doc: PMNode, needle: string): TextRange[] {
  if (!needle) return [];
  const blocks = textBlocks(doc);
  const s = blocks.map((b) => b.text).join('\n');
  const ranges: TextRange[] = [];

  /** 拼接串偏移 → PM 位置。 */
  const posAt = (offset: number): number => {
    let rest = offset;
    for (const b of blocks) {
      if (rest <= b.text.length) return b.start + rest;
      rest -= b.text.length + 1; // 文本 + 块间分隔符
    }
    // 恰落在文末
    const last = blocks[blocks.length - 1];
    return last ? last.start + last.text.length : 0;
  };

  let idx = 0;
  for (;;) {
    const hit = s.indexOf(needle, idx);
    if (hit < 0) break;
    ranges.push({ from: posAt(hit), to: posAt(hit + needle.length) });
    idx = hit + 1;
  }
  if (ranges.length > 0) return ranges;

  const compactNeedle = needle.replace(/\s/g, '');
  if (compactNeedle === '') return [];
  const compactChars: string[] = [];
  const flatOf: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (/\s/.test(ch)) continue;
    compactChars.push(ch);
    flatOf.push(i);
  }
  const compact = compactChars.join('');
  let cIdx = 0;
  for (;;) {
    const hit = compact.indexOf(compactNeedle, cIdx);
    if (hit < 0) break;
    const fromFlat = flatOf[hit]!;
    const toFlat = flatOf[hit + compactNeedle.length - 1]! + 1;
    ranges.push({ from: posAt(fromFlat), to: posAt(toFlat) });
    cIdx = hit + 1;
  }
  return ranges;
}

/** 唯一命中判定：恰好一个命中返回范围，否则给原因。 */
export function locateUnique(
  doc: PMNode,
  needle: string
): { ok: true; range: TextRange } | { ok: false; reason: 'not-found' | 'ambiguous' } {
  const ranges = findTextRanges(doc, needle);
  if (ranges.length === 0) return { ok: false, reason: 'not-found' };
  if (ranges.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, range: ranges[0]! };
}
