/**
 * search_content.test.ts —— 大小写不敏感子串匹配、excerpt 截断、limit。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { searchContent } from '../src/tools.js';
import { makeWorkDir, writeTree } from './helpers.js';

describe('search_content', () => {
  it('大小写不敏感命中并返回 relPath/行号/excerpt', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/卷一/第一章.md': '夜的第七章。\n第二章还没有。',
      'manuscript/卷一/第二章.md': '开头 mention SEVEN times。',
      'manuscript/卷外.txt': '夜的第七章但不在 manuscript 的 md 里。', // 不搜
    });

    const hits = searchContent(work, '第七章');
    expect(hits).toEqual([
      { relPath: 'manuscript/卷一/第一章.md', line: 1, excerpt: '夜的第七章。' },
    ]);

    // 大小写不敏感
    const en = searchContent(work, 'seven');
    expect(en.map((h) => h.line)).toEqual([1]);
    expect(en[0]!.relPath).toBe('manuscript/卷一/第二章.md');
  });

  it('excerpt 前后各 30 字截断并补 …', () => {
    const work = makeWorkDir();
    const longLine = '甲'.repeat(40) + '目标词' + '乙'.repeat(40);
    writeTree(work, { 'manuscript/章.md': longLine });

    const [hit] = searchContent(work, '目标词');
    expect(hit!.excerpt).toBe('…' + '甲'.repeat(30) + '目标词' + '乙'.repeat(30) + '…');
    expect(hit!.excerpt.length).toBe(1 + 30 + 3 + 30 + 1);
    expect(hit!.line).toBe(1);
  });

  it('limit 生效', () => {
    const work = makeWorkDir();
    const lines = Array.from({ length: 50 }, (_, i) => `第${i}行都有目标词`);
    writeTree(work, { 'manuscript/长章.md': lines.join('\n') });

    const hits = searchContent(work, '目标词', 5);
    expect(hits).toHaveLength(5);
    expect(hits[0]!.line).toBe(1);
    expect(hits[4]!.line).toBe(5);

    // 默认 limit=20
    expect(searchContent(work, '目标词')).toHaveLength(20);
  });

  it('空查询与无 manuscript 返回空数组', () => {
    expect(searchContent(makeWorkDir(), '目标词')).toEqual([]);
    expect(searchContent(makeWorkDir(), '')).toEqual([]);
  });

  it('frontmatter 不参与搜索；正文命中行号按文件实际行号（含 fm 行）', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/卷一/第一章.md': '---\ntitle: 第七章的标题\n---\n夜的第七章。\n第二行也有第七章。',
    });

    const hits = searchContent(work, '第七章');
    // title 里的命中不算，正文两处命中，行号 = fm 3 行之后的 4/5
    expect(hits).toEqual([
      { relPath: 'manuscript/卷一/第一章.md', line: 4, excerpt: '夜的第七章。' },
      { relPath: 'manuscript/卷一/第一章.md', line: 5, excerpt: '第二行也有第七章。' },
    ]);
  });

  it('文件读取失败不再静默跳过：console.warn 带路径与错误，返回数组附 skipped 属性', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第1章.md': '目标词在这里。',
      'manuscript/第2章.md': '目标词在坏文件里。',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const realRead = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor) => {
      if (String(file).includes('第2章')) throw new Error('模拟不可读');
      return realRead(file, 'utf8');
    }) as typeof fs.readFileSync);
    try {
      const hits = searchContent(work, '目标词');
      expect(hits.map((h) => h.relPath)).toEqual(['manuscript/第1章.md']);
      expect(hits.skipped).toEqual([{ path: 'manuscript/第2章.md', reason: '模拟不可读' }]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('第2章');
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('全部可读时不出 skipped 属性（可选加法）', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '目标词在这里。' });
    expect(searchContent(work, '目标词').skipped).toBeUndefined();
  });
});

/**
 * 符号链接跳过上报（评审T3）：collectMdFiles 对 symlink 条目不再静默 continue，
 * 经 onSkip 上报、消费端（此处 search_content，已传 onSkip）计入 skipped——扫描不静默漏章。
 * Windows 用目录联接 junction（免管理员权限，readdir dirent 报 isSymbolicLink）。
 */
describe('search_content 符号链接跳过上报', () => {
  it('manuscript 内的 symlink 不再静默漏：计入 skipped、不搜链接内容、仓内正常章不受影响', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '目标词在仓内。' });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-junction-'));
    try {
      fs.writeFileSync(path.join(outside, '外章.md'), '目标词在仓外。', 'utf8');
      fs.symlinkSync(outside, path.join(work, 'manuscript', '外链'), 'junction');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const hits = searchContent(work, '目标词');
        expect(hits.map((h) => h.relPath)).toEqual(['manuscript/第1章.md']); // 链接内容不进搜索
        expect(hits.skipped).toEqual([
          { path: 'manuscript/外链', reason: expect.stringContaining('符号链接') },
        ]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0]?.[0])).toContain('外链');
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
