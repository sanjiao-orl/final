/**
 * path-guard.test.ts —— 越界守卫：../ 逃逸、绝对路径、相对 workDir、Windows 反斜杠逃逸。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deleteChapter,
  deleteVolume,
  listStructure,
  moveChapter,
  moveVolume,
  readChapter,
  readSnapshot,
  renameChapter,
  renameVolume,
  wordCount,
  writeChapter,
} from '../src/tools.js';
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

/**
 * P0 修复回归：原始 relPath 形如 `manuscript/../…` 时，未归一化的 startsWith('manuscript/')
 * 前缀检查会被骗过（实际归一化后落在 .novel/ 等仓内非白名单处）。所有按相对路径操作的
 * 工具必须"先 resolveInsidePosix 归一化、再对 posix 判前缀"。本组逐条实锤：绕过路径一律
 * 抛中文错，且目标文件原样未动（软删类断言 trash 为空）。
 */
describe('路径守卫口径统一（resolveInsidePosix 归一化后判前缀）', () => {
  it('delete_chapter 拒绝 manuscript/../ 绕过到 .novel 的路径，且原文件未动、trash 为空', () => {
    const work = makeWorkDir();
    writeTree(work, { '.novel/ledger.md': '账本内容' });
    for (const rel of ['manuscript/../.novel/ledger.md', 'manuscript/../editorial_notes/issues.md']) {
      expect(() => deleteChapter(work, rel), rel).toThrow(/只允许 manuscript\/ 内的 \.md/);
    }
    // 目标文件原样未动
    expect(fs.readFileSync(path.join(work, '.novel/ledger.md'), 'utf8')).toBe('账本内容');
    expect(fs.existsSync(path.join(work, '.novel/trash'))).toBe(false); // 软删未发生
  });

  it('delete_volume 拒绝 manuscript/../ 绕过到 .novel 的卷路径，原目录未动、trash 为空', () => {
    const work = makeWorkDir();
    writeTree(work, { '.novel/attack/ch.md': '内容' });
    for (const rel of ['manuscript/../.novel/attack', 'manuscript/../editorial_notes']) {
      expect(() => deleteVolume(work, rel), rel).toThrow(/只允许 manuscript\/ 下的卷目录/);
    }
    expect(fs.readFileSync(path.join(work, '.novel/attack/ch.md'), 'utf8')).toBe('内容');
    expect(fs.existsSync(path.join(work, '.novel/trash'))).toBe(false);
  });

  it('rename_chapter / rename_volume 拒绝 manuscript/../ 绕过路径，原文件未动', () => {
    const work = makeWorkDir();
    writeTree(work, { '.novel/ledger.md': '账本', '.novel/attack/ch.md': '内容' });
    expect(() => renameChapter(work, 'manuscript/../.novel/ledger.md', '新')).toThrow(
      /只允许 manuscript\/ 内的 \.md/,
    );
    expect(() => renameVolume(work, 'manuscript/../.novel/attack', '新')).toThrow(
      /只允许 manuscript\/ 下的目录/,
    );
    expect(fs.readFileSync(path.join(work, '.novel/ledger.md'), 'utf8')).toBe('账本');
    expect(fs.readFileSync(path.join(work, '.novel/attack/ch.md'), 'utf8')).toBe('内容');
  });

  it('move_chapter / move_volume 拒绝 manuscript/../ 绕过路径，原文件未动', () => {
    const work = makeWorkDir();
    writeTree(work, { '.novel/ledger.md': '账本', '.novel/attack/ch.md': '内容' });
    expect(() => moveChapter(work, 'manuscript/../.novel/ledger.md', 0)).toThrow(
      /只允许 manuscript\/ 内的 \.md/,
    );
    expect(() => moveVolume(work, 'manuscript/../.novel/attack', 0)).toThrow(
      /只允许 manuscript\/ 下的目录/,
    );
    expect(fs.readFileSync(path.join(work, '.novel/ledger.md'), 'utf8')).toBe('账本');
    expect(fs.readFileSync(path.join(work, '.novel/attack/ch.md'), 'utf8')).toBe('内容');
  });

  it('read_snapshot 拒绝 .novel/history/../ 绕过读取，且不外泄内容', () => {
    const work = makeWorkDir();
    writeTree(work, { '.novel/ledger.md': '机密账本' });
    // 原始串以 .novel/history/ 开头、归一化后落在其外 → 必须拒绝
    expect(() => readSnapshot(work, '.novel/history/../ledger.md')).toThrow(
      /只允许读取 \.novel\/history\/ 内的快照/,
    );
    expect(() => readSnapshot(work, 'manuscript/../.novel/ledger.md')).toThrow();
  });

  it('word_count 带 relPath 时只允许 manuscript/ 内的 .md；无 relPath 全书统计不受影响', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第一章.md': '正文一二三',
      '.novel/ledger.md': '账本四五六',
      'notes.md': '根笔记',
    });
    for (const rel of [
      'manuscript/../.novel/ledger.md',
      'manuscript/../editorial_notes/issues.md',
      '.novel/ledger.md',
      'notes.md',
    ]) {
      expect(() => wordCount(work, rel), rel).toThrow(/只允许 manuscript\/ 内的 \.md/);
    }
    // 无 relPath：全书统计仍正常（只汇总 manuscript 内，不含 .novel/notes）
    expect(wordCount(work).total).toBe(5);
    expect(wordCount(work, 'manuscript/第一章.md').total).toBe(5);
  });

  it('write_chapter 拒绝经 symlink(junction) 指向仓外的路径，且仓外无落盘', () => {
    const work = makeWorkDir();
    fs.mkdirSync(path.join(work, 'manuscript'), { recursive: true });
    // 仓外独立临时目录（与 work 平级、不在 workDir 内）
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-junction-'));
    try {
      const linkPath = path.join(work, 'manuscript', '外联');
      fs.symlinkSync(outside, linkPath, 'junction'); // junction 目录联接免管理员权限
      expect(() => writeChapter(work, 'manuscript/外联/x.md', '不该写入')).toThrow(/符号链接/);
      expect(fs.existsSync(path.join(outside, 'x.md'))).toBe(false); // 仓外未落盘
      writeTree(work, { 'manuscript/正文.md': '正常' }); // 仓内正常写不受影响
      expect(fs.readFileSync(path.join(work, 'manuscript/正文.md'), 'utf8')).toBe('正常');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

/** 回归：正常 manuscript 路径下各工具行为不变（与既有测试一致，另复验一遍白名单不被误伤）。 */
describe('路径守卫口径统一——正常路径回归', () => {
  it('word_count/rename/move/read_snapshot 的正常路径均正常', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/卷一/第一章.md': '正文',
      'manuscript/卷一/第二章.md': '正文二',
    });
    // word_count 正常
    expect(wordCount(work, 'manuscript/卷一/第一章.md').total).toBe(2);
    // 覆盖写旧文件 → 产生历史快照；read_snapshot 读回旧版正常
    writeChapter(work, 'manuscript/卷一/第一章.md', '新版正文');
    const snapRel = walkHistory(work);
    expect(snapRel).toBeTruthy();
    const snap = readSnapshot(work, snapRel as string);
    expect(snap.ok).toBe(true);
    expect(snap.content).toBe('正文');
    // rename 正常
    expect(renameChapter(work, 'manuscript/卷一/第一章.md', '少年').relPath).toMatch(
      /manuscript\/卷一\/第[一二三四五六七八九十百\d]+章·少年\.md/,
    );
    // move（卷内重排）正常
    expect(moveChapter(work, 'manuscript/卷一/第二章.md', 0).ok).toBe(true);
  });

  it('delete_chapter / delete_volume 正常路径软删照旧', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第一章.md': '正文' });
    expect(deleteChapter(work, 'manuscript/卷一/第一章.md').ok).toBe(true);
    // 章软删后卷内为空卷，仍可整卷软删
    expect(deleteVolume(work, 'manuscript/卷一').ok).toBe(true);
  });
});

/** 取 .novel/history 下第一个 .md 快照的相对 workDir 路径（正斜杠）；无则 undefined。 */
function walkHistory(work: string): string | undefined {
  return walk(posixJoin('.novel', 'history'));
  function posixJoin(...segs: string[]): string {
    return segs.join('/');
  }
  function walk(rel: string): string | undefined {
    const abs = path.join(work, ...rel.split('/'));
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const e of entries) {
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        const found = walk(childRel);
        if (found) return found;
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        return childRel;
      }
    }
    return undefined;
  }
}
