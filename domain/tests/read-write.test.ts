/**
 * read_write.test.ts —— read_chapter / write_chapter：正常读写、原子写两种情形、.md 限制。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readChapter, writeChapter } from '../src/tools.js';
import { makeWorkDir, writeTree } from './helpers.js';

const CH = ['---', 'title: 第一章', 'status: 完稿', '---', '', '正文内容。'].join('\n');

describe('read_chapter', () => {
  it('返回原文与解析后的 frontmatter', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第一章.md': CH });
    const { content, frontmatter } = readChapter(work, 'manuscript/卷一/第一章.md');
    expect(content).toBe(CH);
    expect(frontmatter).toEqual({ title: '第一章', status: '完稿' });
  });

  it('无 frontmatter 时返回空对象与全文', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/裸章.md': '只有正文。' });
    expect(readChapter(work, 'manuscript/裸章.md')).toEqual({
      content: '只有正文。',
      frontmatter: {},
    });
  });

  it('文件不存在时抛错', () => {
    expect(() => readChapter(makeWorkDir(), 'manuscript/没有.md')).toThrow();
  });
});

describe('write_chapter', () => {
  it('目标不存在：自动建父目录并原子写入', () => {
    const work = makeWorkDir();
    const res = writeChapter(work, 'manuscript/卷二/第三章.md', CH);
    expect(res.ok).toBe(true);
    expect(res.bytes).toBe(Buffer.byteLength(CH, 'utf8'));
    expect(fs.readFileSync(path.join(work, 'manuscript/卷二/第三章.md'), 'utf8')).toBe(CH);
  });

  it('目标已存在：覆盖成功且不留临时文件', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第一章.md': '旧内容' });
    const dir = path.join(work, 'manuscript/卷一');
    expect(fs.readdirSync(dir)).toEqual(['第一章.md']);

    const res = writeChapter(work, 'manuscript/卷一/第一章.md', CH);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(work, 'manuscript/卷一/第一章.md'), 'utf8')).toBe(CH);
    // 原子写不得残留 .tmp
    expect(fs.readdirSync(dir)).toEqual(['第一章.md']);
  });

  it('拒绝非 .md 后缀', () => {
    const work = makeWorkDir();
    expect(() => writeChapter(work, 'manuscript/笔记.txt', 'x')).toThrow(/只允许 .md/);
    expect(() => writeChapter(work, 'manuscript/笔记.MD', 'x')).not.toThrow(); // 大小写不敏感放行
  });
});
