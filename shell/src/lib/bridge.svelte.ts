/**
 * bridge.svelte.ts —— 编辑器选区与 AI 对话的桥接：引用草稿与浮层打磨留痕。
 */
import { chat } from './chat.svelte.js';
import { ui } from './ui.svelte.js';
import type { ChapterNode } from './types.js';

function chapterScope(chapter: ChapterNode): string {
  return `ch:${chapter.id ?? chapter.relPath}`;
}

export function splitLeadingQuote(content: string): { quote: string; body: string } {
  const match = content.match(/^(?:> .*\n?)+/);
  if (!match) return { quote: '', body: content };
  const quote = match[0].replace(/\n$/, '');
  const body = content.slice(match[0].length).replace(/^\n+/, '');
  return { quote, body };
}

export async function quoteSelectionToChat(chapter: ChapterNode, text: string): Promise<void> {
  await chat.setScope(chapterScope(chapter));
  ui.showCol('chat');
  const key = chat.currentDraftKey();
  chat.setQuote(key, { label: `引用 · ${chapter.title} · ${text.length} 字`, text });
}

export async function transferPolishToChat(
  chapter: ChapterNode,
  original: string,
  rounds: Array<{ instruction: string; text: string }>,
): Promise<void> {
  const history = rounds
    .map((round, i) => `第${i + 1}轮指令：${round.instruction}\n第${i + 1}版：\n${round.text}`)
    .join('\n\n');
  const message = [
    `选区原文：\n${original}`,
    `打磨记录：\n${history || '（无已完成版本）'}`,
    '继续打磨；产出新版本一律用 stage_chapter_proposal 工具提交，mode=replace，original 填上面的选区原文。',
  ].join('\n\n');
  await chat.setScope(chapterScope(chapter));
  ui.showCol('chat');
  await chat.send(message);
}

/** 浮层每轮完成后追加的可测纯函数。 */
export function appendPolishRound(
  rounds: Array<{ instruction: string; text: string }>,
  instruction: string,
  text: string,
): Array<{ instruction: string; text: string }> {
  return [...rounds, { instruction, text }];
}

export function polishInstruction(input: string, variant: string): string {
  return input.trim() || variant;
}

export function quoteBlock(text: string): string {
  return text.split('\n').map((line) => `> ${line}`).join('\n');
}
