/**
 * search_content.test.ts —— 大小写不敏感子串匹配、excerpt 截断、limit。
 */
import { describe, expect, it } from 'vitest';
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
});
