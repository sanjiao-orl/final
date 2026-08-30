#!/usr/bin/env node
/**
 * import-txt.mjs —— 本地 txt 长篇导入器（试车台批降级路径：平台反爬时用作者本地 txt 灌语料）
 *
 * 用法：node scripts/bench/import-txt.mjs <txt路径> --book <书名> [--out .bench/work] [--chars 4000]
 * - 编码自动识别：UTF-8（含 BOM）→ 失败回退 GB18030（Node 内置 ICU）
 * - 分章：优先按「第N章/回/节」标题行切；识别不足 5 章则按 --chars 定长切（合成 第N章 标题）
 * - 产出：<out>/<书名>/manuscript/正文/<章题>.md（frontmatter：title/order/status: 语料/source/wordNumber）
 * 纪律：作者本地已有文本，只进 .bench/（gitignored），不进仓不分发。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const txtPath = args[0];
const flagVal = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const book = flagVal('--book', null);
const outRoot = flagVal('--out', '.bench/work');
const CHUNK_CHARS = Number(flagVal('--chars', 4000));
if (!txtPath || !book || !fs.existsSync(txtPath)) {
  console.error('用法：node scripts/bench/import-txt.mjs <txt路径> --book <书名> [--out .bench/work] [--chars 4000]');
  process.exit(2);
}

function readTextAuto(p) {
  const buf = fs.readFileSync(p);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('gb18030').decode(buf);
  }
}

const CHAPTER_HEAD = /^[ \t　]*第[0-9零一二两三四五六七八九十百千万]+[章回节][^\n]{0,40}$/gm;

function splitChapters(text) {
  const heads = [...text.matchAll(CHAPTER_HEAD)];
  if (heads.length >= 5) {
    const out = [];
    for (let i = 0; i < heads.length; i++) {
      const start = heads[i].index + heads[i][0].length;
      const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
      const body = text.slice(start, end).trim();
      if (body) out.push({ title: heads[i][0].trim(), body });
    }
    return { mode: '标题分章', chapters: out };
  }
  // 定长回退
  const out = [];
  for (let i = 0, n = 1; i < text.length; n++) {
    const body = text.slice(i, i + CHUNK_CHARS).trim();
    if (!body) break;
    out.push({ title: `第${n}章`, body });
    i += CHUNK_CHARS;
  }
  return { mode: `定长分章(${CHUNK_CHARS}字)`, chapters: out };
}

function sanitize(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '·')
    .replace(/\s+/g, ' ')
    .trim();
}

const text = readTextAuto(txtPath);
const { mode, chapters } = splitChapters(text);
const volDir = path.join(outRoot, sanitize(book), 'manuscript', '正文');
fs.mkdirSync(volDir, { recursive: true });

let total = 0;
chapters.forEach((ch, i) => {
  const order = i + 1;
  const fm = [
    '---',
    `title: ${ch.title}`,
    'status: 语料',
    `source: 本地txt导入（${path.basename(txtPath)}）`,
    'volume: 正文',
    `order: ${order}`,
    `wordNumber: ${ch.body.replace(/\s/g, '').length}`,
    '---',
    '',
  ];
  fs.writeFileSync(path.join(volDir, `${sanitize(ch.title)}.md`), fm.join('\n') + ch.body + '\n', 'utf8');
  total += ch.body.length;
});

console.log(`导入完成：《${book}》${chapters.length} 章（${mode}），合计 ${total} 字符 → ${volDir}`);
