/**
 * history.test.ts —— 历史快照读取：write_chapter 覆盖写后 list_snapshots 能列出、
 * read_snapshot 内容为旧版本、越界/非 history 路径抛错、无 history 目录返回空。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSnapshots, readSnapshot, writeChapter } from '../src/tools.js';
import { makeWorkDir, writeTree } from './helpers.js';

const OLD = ['---', 'title: 第一章', 'status: 草稿', '---', '', '旧正文。'].join('\n');
const NEW = OLD.replace('旧正文。', '新正文。');

describe('list_snapshots', () => {
  it('write_chapter 覆盖写后能列出该章快照（path 相对 workDir，timestamp 为文件名）', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第一章.md': OLD });
    writeChapter(work, 'manuscript/卷一/第一章.md', NEW);
    const res = listSnapshots(work, 'manuscript/卷一/第一章.md');
    expect(res.snapshots).toHaveLength(1);
    const snap = res.snapshots[0]!;
    expect(snap.path).toMatch(/^\.novel\/history\/manuscript__卷一__第一章\/.+\.md$/);
    expect(snap.timestamp).toBe(snap.path.split('/').pop());
    expect(fs.existsSync(path.join(work, ...snap.path.split('/')))).toBe(true);
  });

  it('不带 relPath 时按章拍平目录分组', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/卷一/第一章.md': OLD,
      'manuscript/卷一/第二章.md': OLD,
    });
    writeChapter(work, 'manuscript/卷一/第一章.md', NEW);
    writeChapter(work, 'manuscript/卷一/第二章.md', NEW);
    const res = listSnapshots(work);
    expect(res.snapshots).toHaveLength(2);
    for (const g of res.snapshots) {
      expect(g.files).toHaveLength(1);
      expect(g.files[0]!.path).toMatch(new RegExp(`^\\.novel/history/${g.chapterFlatten}/.+\\.md$`));
    }
    expect(res.snapshots.map((g) => g.chapterFlatten)).toEqual([
      'manuscript__卷一__第一章',
      'manuscript__卷一__第二章',
    ]);
  });

  it('快照按时间戳文件名倒序（新在前）', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第一章.md': OLD });
    writeChapter(work, 'manuscript/卷一/第一章.md', NEW + 'A');
    writeChapter(work, 'manuscript/卷一/第一章.md', NEW + 'B');
    const res = listSnapshots(work, 'manuscript/卷一/第一章.md');
    expect(res.snapshots).toHaveLength(2);
    expect(res.snapshots[0]!.timestamp > res.snapshots[1]!.timestamp).toBe(true);
  });

  it('无 history 目录时返回空数组，不抛错', () => {
    const work = makeWorkDir();
    expect(listSnapshots(work)).toEqual({ snapshots: [] });
    expect(listSnapshots(work, 'manuscript/第一章.md')).toEqual({ snapshots: [] });
  });
});

describe('read_snapshot', () => {
  it('内容等于被覆盖前的旧内容', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第一章.md': OLD });
    writeChapter(work, 'manuscript/卷一/第一章.md', NEW);
    const snap = listSnapshots(work, 'manuscript/卷一/第一章.md').snapshots[0]!;
    const res = readSnapshot(work, snap.path);
    expect(res.ok).toBe(true);
    expect(res.content).toBe(OLD);
  });

  it('越界/非 .novel/history/ 路径抛错（防止任意文件读取）', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第一章.md': OLD, '笔记.md': '根目录' });
    expect(() => readSnapshot(work, '../逃逸.md')).toThrow();
    expect(() => readSnapshot(work, 'manuscript/卷一/第一章.md')).toThrow(/history/);
    expect(() => readSnapshot(work, '.novel/history/不是快照.txt')).toThrow(/\.md/);
    expect(() => readSnapshot(work, '.novel/trash/x.md')).toThrow(/history/);
  });
});
