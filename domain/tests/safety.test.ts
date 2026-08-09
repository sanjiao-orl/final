/**
 * safety.test.ts —— 安全阀四件的领域侧：滚动快照（.novel/history）、软删（.novel/trash）、
 * 全稿导出 txt，以及 read_chapter 的 body/frontmatterRaw 拆分。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deleteChapter,
  exportTxt,
  readChapter,
  SNAPSHOT_KEEP,
  writeChapter,
} from '../src/tools.js';
import { makeWorkDir, writeTree } from './helpers.js';

const CH = ['---', 'title: 第一章', 'status: 草稿', 'custom: 保留我', '---', '', '旧正文。'].join('\n');

describe('read_chapter 拆分', () => {
  it('frontmatterRaw 原样返回（字节级），body 为去壳正文，可原样回拼', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第一章.md': CH });
    const { content, frontmatterRaw, body } = readChapter(work, 'manuscript/卷一/第一章.md');
    expect(frontmatterRaw).toBe('---\ntitle: 第一章\nstatus: 草稿\ncustom: 保留我\n---\n');
    expect(body).toBe('\n旧正文。');
    expect(frontmatterRaw + body).toBe(content);
  });
});

describe('write_chapter 滚动快照', () => {
  const historyDir = (work: string): string =>
    path.join(work, '.novel', 'history', 'manuscript__卷一__第一章');

  it('新文件首写不产生快照', () => {
    const work = makeWorkDir();
    writeChapter(work, 'manuscript/卷一/第一章.md', CH);
    expect(fs.existsSync(path.join(work, '.novel', 'history'))).toBe(false);
  });

  it('覆盖写前把旧内容快照进 .novel/history，内容为旧版本', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第一章.md': CH });
    writeChapter(work, 'manuscript/卷一/第一章.md', CH.replace('旧正文。', '新正文。'));
    const snaps = fs.readdirSync(historyDir(work));
    expect(snaps).toHaveLength(1);
    const snap = fs.readFileSync(path.join(historyDir(work), snaps[0]!), 'utf8');
    expect(snap).toBe(CH); // 快照是被覆盖前的旧内容
    // 正文文件已是新内容
    expect(fs.readFileSync(path.join(work, 'manuscript/卷一/第一章.md'), 'utf8')).toContain('新正文。');
  });

  it('内容未变化的重复写不产生快照', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第一章.md': CH });
    writeChapter(work, 'manuscript/卷一/第一章.md', CH);
    expect(fs.existsSync(path.join(work, '.novel', 'history'))).toBe(false);
  });

  it(`滚动裁剪：最多保留 ${SNAPSHOT_KEEP} 份`, () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第一章.md': CH });
    for (let i = 1; i <= SNAPSHOT_KEEP + 5; i++) {
      writeChapter(work, 'manuscript/卷一/第一章.md', `${CH}\n第 ${i} 次改动。`);
    }
    expect(fs.readdirSync(historyDir(work))).toHaveLength(SNAPSHOT_KEEP);
  });
});

describe('delete_chapter 软删', () => {
  it('manuscript 内的 .md 移进 .novel/trash，可移回找回', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第一章.md': CH });
    const { ok, trashPath } = deleteChapter(work, 'manuscript/卷一/第一章.md');
    expect(ok).toBe(true);
    expect(trashPath).toMatch(/^\.novel\/trash\/manuscript__卷一__第一章-.+\.md$/);
    expect(fs.existsSync(path.join(work, 'manuscript/卷一/第一章.md'))).toBe(false);
    const trashAbs = path.join(work, ...trashPath.split('/'));
    expect(fs.readFileSync(trashAbs, 'utf8')).toBe(CH);
    // 找回：从 trash 移回原路径
    fs.renameSync(trashAbs, path.join(work, 'manuscript/卷一/第一章.md'));
    expect(fs.readFileSync(path.join(work, 'manuscript/卷一/第一章.md'), 'utf8')).toBe(CH);
  });

  it('拒绝删 manuscript 之外的文件与越界路径', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第一章.md': CH, '.novel/x.md': '内部', '笔记.md': '根目录' });
    expect(() => deleteChapter(work, '.novel/x.md')).toThrow(/manuscript/);
    expect(() => deleteChapter(work, '笔记.md')).toThrow(/manuscript/);
    expect(() => deleteChapter(work, '../外面.md')).toThrow();
    expect(() => deleteChapter(work, 'manuscript/卷一/不存在.md')).toThrow();
    // 原有文件未被误伤
    expect(fs.existsSync(path.join(work, 'manuscript/卷一/第一章.md'))).toBe(true);
  });
});

describe('export_txt 全稿导出', () => {
  const CH2 = ['---', 'title: 第二章·客栈', 'status: 打磨', '---', '', '客栈正文。'].join('\n');

  it('按卷→章顺序合并，去 frontmatter 与 ###，卷名独占一行', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第一卷·风起/第一章·少年.md': CH.replace('title: 第一章', 'title: 第一章·少年'),
      'manuscript/第一卷·风起/第二章·客栈.md': CH2,
    });
    const { ok, path: outPath, chapters, bytes } = exportTxt(work);
    expect(ok).toBe(true);
    expect(chapters).toBe(2);
    const txt = fs.readFileSync(path.join(work, outPath), 'utf8');
    expect(bytes).toBe(Buffer.byteLength(txt, 'utf8'));
    expect(txt).not.toContain('---');
    expect(txt).not.toContain('###');
    expect(txt).toContain('第一卷·风起');
    // 章序与正文在场
    const i1 = txt.indexOf('第一章·少年');
    const i2 = txt.indexOf('第二章·客栈');
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
    expect(txt).toContain('旧正文。');
    expect(txt).toContain('客栈正文。');
    // 导出文件在 workDir 根，txt 后缀
    expect(outPath).toMatch(/^全稿-.+\.txt$/);
  });

  it('场景标题去掉 ### 保留题名行', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第一章.md': ['---', 'title: 唯一章', '---', '', '开头。', '', '### 临行', '', '正文。'].join('\n'),
    });
    const txt = fs.readFileSync(path.join(work, exportTxt(work).path), 'utf8');
    expect(txt).toContain('\n临行\n');
    expect(txt).not.toContain('###');
    // 未分卷时不输出卷名行
    expect(txt.startsWith('唯一章')).toBe(true);
  });
});
