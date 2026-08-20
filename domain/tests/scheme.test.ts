/**
 * scheme.test.ts —— scheme_set_active：把「激活方案」指针写入作品目录。
 * 覆盖：写入指定方案名落盘/内容/无 .tmp 残留、不存在的名报错并列出可用方案、
 * 书级同名遮蔽 app 级、name='' 删除指针回默认（含幂等）、workDir 非法抛错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { schemeSetActive } from '../src/prompts.js';
import { makeWorkDir, writeTree } from './helpers.js';

describe('scheme_set_active', () => {
  it('写入存在的方案名：指针文件落盘、内容正确、无 .tmp 残留', () => {
    const work = makeWorkDir();
    const app = makeWorkDir();
    writeTree(app, {
      'schemes/基础.md': '---\nname: 基础打磨\ndescription: app 级方案\n---\n正文',
    });
    const res = schemeSetActive(work, '基础打磨', app);
    expect(res).toEqual({ ok: true, active: '基础打磨' });
    const pointer = path.join(work, '.novel/active-scheme');
    expect(fs.readFileSync(pointer, 'utf8')).toBe('基础打磨\n');
    // 原子写不留 .tmp 残留
    const dotNovel = path.join(work, '.novel');
    expect(fs.readdirSync(dotNovel).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('不存在的名报错，且消息含可用方案名列表', () => {
    const work = makeWorkDir();
    const app = makeWorkDir();
    writeTree(app, {
      'schemes/a.md': '---\nname: 方案甲\n---\n',
      'schemes/b.md': '---\nname: 方案乙\n---\n',
    });
    expect(() => schemeSetActive(work, '不存在的方案', app)).toThrow(/scheme_set_active 找不到方案/);
    expect(() => schemeSetActive(work, '不存在的方案', app)).toThrow(/方案甲/);
    expect(() => schemeSetActive(work, '不存在的方案', app)).toThrow(/方案乙/);
    // 报错时不落指针文件
    expect(fs.existsSync(path.join(work, '.novel/active-scheme'))).toBe(false);
  });

  it('书级同名遮蔽 app 级时书级可激活', () => {
    const work = makeWorkDir();
    const app = makeWorkDir();
    writeTree(app, {
      'schemes/x.md': '---\nname: 主角流\n---\napp 版正文',
    });
    writeTree(work, {
      '.novel/schemes/x.md': '---\nname: 主角流\n---\n书级版正文',
    });
    const res = schemeSetActive(work, '主角流', app);
    expect(res).toEqual({ ok: true, active: '主角流' });
    expect(fs.readFileSync(path.join(work, '.novel/active-scheme'), 'utf8')).toBe('主角流\n');
  });

  it("name='' 删除指针回默认，指针本就不存在也幂等成功", () => {
    const work = makeWorkDir();
    const app = makeWorkDir();
    writeTree(app, { 'schemes/a.md': '---\nname: 方案甲\n---\n' });
    // 先激活再清空
    schemeSetActive(work, '方案甲', app);
    expect(fs.existsSync(path.join(work, '.novel/active-scheme'))).toBe(true);
    expect(schemeSetActive(work, '', app)).toEqual({ ok: true, active: null });
    expect(fs.existsSync(path.join(work, '.novel/active-scheme'))).toBe(false);
    // 幂等：本来就不存在也 ok
    expect(schemeSetActive(work, '', app)).toEqual({ ok: true, active: null });
  });

  it('workDir 非法（相对路径）抛错', () => {
    const app = makeWorkDir();
    writeTree(app, { 'schemes/a.md': '---\nname: 方案甲\n---\n' });
    expect(() => schemeSetActive('relative/path', '方案甲', app)).toThrow(/workDir 必须是绝对路径/);
  });
});