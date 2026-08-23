/**
 * markdown.ts —— 正文 markdown 与编辑器 HTML 的双向桥（marked + turndown）。
 * 真相永远在 .md 正文；这里只做呈现层转换，不碰 frontmatter（壳从 read_chapter 拿拆好的 body/frontmatterRaw）。
 * md→HTML 侧统一过 sanitizeHtml：AI 采纳的 proposed 也是 LLM 输出，进编辑器（innerHTML/insertContentAt）前净化。
 */
import { marked } from 'marked';
import TurndownService from 'turndown';
import { sanitizeHtml } from './sanitize.js';

const turndown = new TurndownService({
  headingStyle: 'atx', // ### 场景标题往返不变形
  bulletListMarker: '-',
  emDelimiter: '*',
  codeBlockStyle: 'fenced', // 代码块一律输出围栏:围栏内空行逐字节保留,折叠逻辑可感知
  fence: '```',
});

/** 正文 md → 编辑器初始 HTML（净化后）。只剥首尾换行，不动前导空白（4 空格缩进代码块开头的章不能被破坏）。 */
export function mdToHtml(md: string): string {
  const html = marked.parse(md.replace(/^\n+|\n+$/g, ''), { async: false, gfm: true });
  return sanitizeHtml(html as string);
}

/**
 * 编辑器 HTML → 可落盘的正文 md（收尾一个换行，与章文件惯例一致）。
 * 连续空行折叠为单空行（\n\n\n → \n\n），但围栏代码块（``` / ~~~）内部逐字节保留——真相永远在正文文件。
 */
export function htmlToMd(html: string): string {
  const md = collapseBlankLines(turndown.turndown(html)).trimEnd();
  return md === '' ? '' : md + '\n';
}

/** 连续空行折叠（\n{3,} → \n\n），围栏代码块内跳过，逐行扫描围栏状态。 */
function collapseBlankLines(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceChar = '';
  for (const line of lines) {
    if (!inFence) {
      const open = /^\s*(```+|~~~+)/.exec(line);
      if (open) {
        inFence = true;
        fenceChar = open[1]![0]!;
      }
    } else if (new RegExp(`^\\s*${fenceChar}{3,}`).test(line)) {
      inFence = false;
    }
    // 折叠条件：非围栏内、当前是空行、上一行也是空行
    if (!inFence && line === '' && out.length > 0 && out[out.length - 1] === '') continue;
    out.push(line);
  }
  return out.join('\n');
}

/** 空正文判定（用于保存时允许写空章）。 */
export function isBlankHtml(html: string): boolean {
  return htmlToMd(html) === '';
}
