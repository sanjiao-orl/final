/**
 * trash.test.ts —— list_trash / restore_trash：回收站收口进 domain（壳 localStorage 跟踪的替代）
 * 与找回闭环（move-back，trash 副本不再残留）。
 * 覆盖：删章/删卷还原 originalPath+deletedAt、空 trash、垃圾文件名容错、隐藏文件跳过、新→旧排序；
 * restore_trash：章/卷 move-back、目标已存在拒绝不覆盖、无时间戳报错、非 manuscript/ 原路径拒绝。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteChapter, deleteVolume, listTrash, readChapter, restoreTrash } from '../src/tools.js';
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

describe('restore_trash', () => {
  it('章 move-back 成功：原路径内容一致，trash 副本不再被 list_trash 列出', () => {
    const wd = makeWorkDir();
    const content = '---\ntitle: 第1章·少年\n---\n\n正文。';
    writeTree(wd, { [CH1]: content });
    const { trashPath } = deleteChapter(wd, CH1);
    const r = restoreTrash(wd, trashPath);
    expect(r).toEqual({ ok: true, restoredPath: CH1, kind: 'chapter' });
    expect(readChapter(wd, CH1).content).toBe(content); // 原路径内容一致
    expect(fs.existsSync(path.join(wd, trashPath))).toBe(false); // move-back 非复制：副本消失
    expect(listTrash(wd).entries).toHaveLength(0); // 回收站不再列出（不残留脏副本）
  });

  it('卷目录 move-back 成功：整卷移回，kind=volume', () => {
    const wd = makeWorkDir();
    writeTree(wd, { [`${VOL}/第1章·少年.md`]: '---\ntitle: 第1章·少年\n---\n\n正文。' });
    const { trashPath } = deleteVolume(wd, VOL);
    const r = restoreTrash(wd, trashPath);
    expect(r).toEqual({ ok: true, restoredPath: VOL, kind: 'volume' });
    expect(fs.existsSync(path.join(wd, VOL, '第1章·少年.md'))).toBe(true);
    expect(fs.existsSync(path.join(wd, trashPath))).toBe(false);
    expect(listTrash(wd).entries).toHaveLength(0);
  });

  it('目标已存在 → 拒绝且不覆盖', () => {
    const wd = makeWorkDir();
    writeTree(wd, { [CH1]: '旧版正文' });
    const { trashPath } = deleteChapter(wd, CH1);
    writeTree(wd, { [CH1]: '新版正文' }); // 目标已存在
    expect(() => restoreTrash(wd, trashPath)).toThrow(/目标已存在/);
    expect(fs.readFileSync(path.join(wd, CH1), 'utf8')).toBe('新版正文'); // 不覆盖
    expect(fs.existsSync(path.join(wd, trashPath))).toBe(true); // trash 副本原地不动
  });

  it('无时间戳条目 → 报错提示手动处理', () => {
    const wd = makeWorkDir();
    plantTrashFile(wd, '随手丢进来的.md');
    expect(() => restoreTrash(wd, '.novel/trash/随手丢进来的.md')).toThrow(/无法从文件名还原原路径/);
  });

  it('originalPath 越界（非 manuscript/ 开头）→ 拒绝移动', () => {
    const wd = makeWorkDir();
    plantTrashFile(wd, '.novel__ledger-20260101-000000000-ab12.md');
    expect(() => restoreTrash(wd, '.novel/trash/.novel__ledger-20260101-000000000-ab12.md')).toThrow(
      /不在 manuscript\/ 下/,
    );
  });

  it('trashPath 不在 .novel/trash/ 正下（子目录）→ 拒绝', () => {
    const wd = makeWorkDir();
    expect(() => restoreTrash(wd, '.novel/trash/sub/manuscript__x-20260101-000000000-ab12.md')).toThrow(
      /只允许 .novel\/trash\/ 正下的条目/,
    );
  });
});
