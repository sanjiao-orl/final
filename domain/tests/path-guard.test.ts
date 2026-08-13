/**
 * path-guard.test.ts —— 越界守卫：../ 逃逸、绝对路径、相对 workDir、Windows 反斜杠逃逸。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listStructure, readChapter, wordCount, writeChapter } from '../src/tools.js';
import { makeWorkDir, writeTree } from './helpers.js';

/** 各种 ../ 逃逸写法（含 Windows 反斜杠分隔符，win32 下 \\ 也是分隔符）。 */
const ESCAPES: string[] = ['../secret.md', 'sub/../../secret.md', 'a/..\\..\\secret.md'];

describe('路径守卫', () => {
  it('read_chapter 拒绝 ../ 与绝对路径逃逸', () => {
    const work = makeWorkDir();
    fs.writeFileSync(path.join(work, 'secret.md'), '机密');
    for (const rel of ESCAPES) {
      expect(() => readChapter(work, rel), rel).toThrow(/越界|绝对路径/);
    }
    expect(() => readChapter(work, path.join(work, 'secret.md'))).toThrow(/绝对路径/);
    expect(() => readChapter(work, 'C:\\Windows\\win.ini')).toThrow(/绝对路径/);
  });

  it('write_chapter 拒绝越界且不会在 workDir 外落盘', () => {
    const work = makeWorkDir();
    const outside = path.join(path.dirname(work), 'domain-escape-attempt.md');
    fs.rmSync(outside, { force: true });
    for (const rel of ['../escape.md', 'a/../../escape.md']) {
      expect(() => writeChapter(work, rel, 'x'), rel).toThrow(/越界|绝对路径/);
    }
    expect(fs.existsSync(outside)).toBe(false); // 越界写入必须未发生
  });

  it('read_chapter 拒绝 manuscript/ 外的路径（含 .novel 内部与根目录 .md）', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第一章.md': '正文',
      'notes.md': '根目录笔记',
      '.novel/sessions.sqlite': '内部状态',
    });
    for (const rel of ['notes.md', 'manuscript/../notes.md', '.novel/sessions.sqlite', 'manuscript/笔记.txt', '.novel/history/第一章.md']) {
      expect(() => readChapter(work, rel), rel).toThrow(/manuscript|trash/);
    }
    expect(readChapter(work, 'manuscript/第一章.md').content).toBe('正文');
  });

  it('read_chapter 放开 .novel/trash/ 内的 .md 软删副本（拒绝删章补偿找回用）', () => {
    const work = makeWorkDir();
    writeTree(work, { '.novel/trash/第一章.md': '被删正文' });
    expect(readChapter(work, '.novel/trash/第一章.md').content).toBe('被删正文');
    expect(() => readChapter(work, '.novel/trash/notes.txt')).toThrow(/manuscript|trash/);
  });

  it('write_chapter 拒绝 manuscript/ 外的路径且不会落盘', () => {
    const work = makeWorkDir();
    for (const rel of ['notes.md', 'manuscript/../notes.md', '.novel/history/第一章.md']) {
      expect(() => writeChapter(work, rel, 'x'), rel).toThrow(/manuscript/);
      expect(fs.existsSync(path.join(work, rel))).toBe(false);
    }
  });

  it('word_count 的 relPath 同样受守卫约束', () => {
    const work = makeWorkDir();
    expect(() => wordCount(work, '../外部.md')).toThrow(/越界|绝对路径/);
    expect(() => wordCount(work, 'C:\\Windows\\win.ini')).toThrow(/绝对路径/);
  });

  it('workDir 必须是绝对路径', () => {
    const rel = 'domain-tmp-relative-work';
    fs.mkdirSync(rel, { recursive: true });
    try {
      fs.writeFileSync(path.join(rel, 'x.md'), 'x');
      expect(() => readChapter(rel, 'x.md')).toThrow(/绝对路径/);
      expect(() => writeChapter(rel, 'x.md', 'x')).toThrow(/绝对路径/);
      expect(() => listStructure(rel)).toThrow(/绝对路径/);
    } finally {
      fs.rmSync(rel, { recursive: true, force: true });
    }
  });

  it('合法路径（含子目录）正常放行', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第一章.md': '正文' });
    expect(readChapter(work, 'manuscript/卷一/第一章.md').content).toBe('正文');
    expect(wordCount(work, 'manuscript/卷一/第一章.md').total).toBe(2);
  });
});
