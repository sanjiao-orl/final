/**
 * chapter-blueprint.test.ts —— chapter_set_blueprint：章 frontmatter blueprint（蓝图碰撞模式）
 * 改/增/删/新建最小块，正文与其余字段字节级保留（批一③ 碰撞模式）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chapterSetBlueprint } from '../src/tools.js';
import { makeWorkDir, writeTree } from './helpers.js';

function read(work: string, rel: string): string {
  return fs.readFileSync(path.join(work, rel), 'utf8');
}

describe('chapterSetBlueprint', () => {
  it('改已有 blueprint 行,其余字段与正文字节不动', () => {
    const work = makeWorkDir();
    const body = '第一段正文。\n\n第二段。\n';
    writeTree(work, { 'manuscript/卷一/第一章.md': `---\ntitle: 第一章\nstatus: 草稿\nblueprint: draft\n---\n${body}` });
    const res = chapterSetBlueprint(work, 'manuscript/卷一/第一章.md', 'locked');
    expect(res).toEqual({ relPath: 'manuscript/卷一/第一章.md', blueprint: 'locked' });
    const out = read(work, 'manuscript/卷一/第一章.md');
    expect(out).toContain('blueprint: locked');
    expect(out).not.toContain('blueprint: draft');
    expect(out.endsWith(body)).toBe(true); // 正文字节保留
  });

  it('已有 fm 无 blueprint → fm 块内追加一行', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '---\ntitle: 第1章\nstatus: 完稿\n---\n正文内容。\n' });
    chapterSetBlueprint(work, 'manuscript/第1章.md', 'draft');
    const out = read(work, 'manuscript/第1章.md');
    expect(out).toContain('blueprint: draft');
    expect(out).toContain('status: 完稿'); // 其余键保留
    expect(out.endsWith('正文内容。\n')).toBe(true); // 正文不动
  });

  it('value=none 删除 blueprint 行(缺省即 none,不留垃圾键),fm 块其余键保留', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '---\ntitle: 第1章\nstatus: 草稿\nblueprint: locked\n---\n正文。\n' });
    const res = chapterSetBlueprint(work, 'manuscript/第1章.md', 'none');
    expect(res.blueprint).toBe('none');
    const out = read(work, 'manuscript/第1章.md');
    expect(out).not.toContain('blueprint');
    expect(out).toContain('title: 第1章');
    expect(out).toContain('status: 草稿'); // 其余键保留不动
    expect(out.endsWith('正文。\n')).toBe(true);
  });

  it('无 fm 新建仅 title/blueprint 的最小块再拼原正文(不造 id/status 等其他键)', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第二卷/第2章·客栈.md': '整章只有正文,没有 frontmatter。\n' });
    const res = chapterSetBlueprint(work, 'manuscript/第二卷/第2章·客栈.md', 'locked');
    expect(res.blueprint).toBe('locked');
    const out = read(work, 'manuscript/第二卷/第2章·客栈.md');
    expect(out.startsWith('---\ntitle: 第2章·客栈\nblueprint: locked\n---\n\n')).toBe(true);
    expect(out).not.toContain('id:');
    expect(out).not.toContain('status:');
    expect(out.endsWith('整章只有正文,没有 frontmatter。\n')).toBe(true); // 原正文原样
  });

  it('无 fm 且 value=none → 缺省即 none,文件不变', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第9章.md': '纯正文。\n' });
    const before = read(work, 'manuscript/第9章.md');
    chapterSetBlueprint(work, 'manuscript/第9章.md', 'none');
    expect(read(work, 'manuscript/第9章.md')).toBe(before);
  });

  it('非 manuscript 路径 / 文件不存在抛中文错', () => {
    const work = makeWorkDir();
    writeTree(work, { '.novel/x.md': 'x' });
    expect(() => chapterSetBlueprint(work, '.novel/x.md', 'draft')).toThrow(/只允许 manuscript/);
    expect(() => chapterSetBlueprint(work, 'AGENTS.md', 'draft')).toThrow(/只允许 manuscript/);
    expect(() => chapterSetBlueprint(work, 'manuscript/不存在.md', 'draft')).toThrow(/不存在/);
  });
});
