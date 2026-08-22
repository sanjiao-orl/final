/**
 * trash.test.ts —— list_trash：回收站列表收口进 domain（壳 localStorage 跟踪的替代）。
 * 覆盖：删章/删卷还原 originalPath+deletedAt、空 trash、垃圾文件名容错、隐藏文件跳过、新→旧排序。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteChapter, deleteVolume, listTrash } from '../src/tools.js';
import { makeWorkDir, writeTree } from './helpers.js';

const CH1 = 'manuscript/第1章·少年.md';
const VOL = 'manuscript/第1卷·风起';

/** 直接向 .novel/trash/ 写一个指定名字的假条目（绕过 delete 流程，控时间戳）。 */
function plantTrashFile(wd: string, name: string): void {
  const dir = path.join(wd, '.novel', 'trash');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), '占位', 'utf8');
}

describe('list_trash', () => {
  it('删章 → 还原 originalPath（含 .md 后缀）/kind=chapter/deletedAt', () => {
    const wd = makeWorkDir();
    writeTree(wd, { [CH1]: '---\ntitle: 第1章·少年\n---\n\n正文。' });
    const { trashPath } = deleteChapter(wd, CH1);
    const { entries } = listTrash(wd);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.trashPath).toBe(trashPath);
    expect(e.kind).toBe('chapter');
    expect(e.originalPath).toBe(CH1); // flattenRel 剥掉的 .md 必须补回
    expect(e.deletedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(e.deletedAt!))).toBe(false);
    expect(e.name).toBe(path.basename(trashPath));
  });

  it('删卷 → kind=volume、originalPath 无 .md 后缀', () => {
    const wd = makeWorkDir();
    writeTree(wd, { [`${VOL}/第1章·少年.md`]: '---\ntitle: 第1章·少年\n---\n\n正文。' });
    deleteVolume(wd, VOL);
    const { entries } = listTrash(wd);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('volume');
    expect(entries[0]!.originalPath).toBe(VOL);
    expect(entries[0]!.deletedAt).toBeDefined();
  });

  it('trash 目录不存在 → 空数组，不抛错', () => {
    const wd = makeWorkDir();
    expect(listTrash(wd)).toEqual({ entries: [] });
  });

  it('无时间戳的垃圾文件名 → 仍列出（只有 name+kind），无 deletedAt/originalPath', () => {
    const wd = makeWorkDir();
    plantTrashFile(wd, '随手丢进来的.md');
    const { entries } = listTrash(wd);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('随手丢进来的.md');
    expect(entries[0]!.kind).toBe('chapter');
    expect(entries[0]!.deletedAt).toBeUndefined();
    expect(entries[0]!.originalPath).toBeUndefined();
  });

  it('隐藏文件跳过；多条目按 deletedAt 新→旧排序', () => {
    const wd = makeWorkDir();
    plantTrashFile(wd, '.DS_Store');
    plantTrashFile(wd, 'manuscript__第1章·甲-20260101-000000000-ab12.md');
    plantTrashFile(wd, 'manuscript__第2章·乙-20260202-000000000-cd34.md');
    const { entries } = listTrash(wd);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.originalPath).toBe('manuscript/第2章·乙.md'); // 新在前
    expect(entries[1]!.originalPath).toBe('manuscript/第1章·甲.md');
  });
});
