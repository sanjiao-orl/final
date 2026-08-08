/**
 * word_count.test.ts —— 全稿汇总（含每章明细）与单章统计；空作品。
 */
import { describe, expect, it } from 'vitest';
import { wordCount } from '../src/tools.js';
import { makeWorkDir, writeTree } from './helpers.js';

describe('word_count', () => {
  it('无 relPath：汇总全 manuscript 并附每章明细', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/卷一/第一章.md': '---\ntitle: 一\n---\n# 开头\n\n正文十一个字符。',
      'manuscript/卷一/第二章.md': '只有正文。',
      'manuscript/卷二/第三章.md': '第三节 内容。',
      'manuscript/卷一/备注.txt': '不算我', // 非 md 不计
    });

    const res = wordCount(work);
    expect(res.total).toBe(22);
    expect(res.files).toEqual([
      { relPath: 'manuscript/卷一/第一章.md', wordCount: 11 },
      { relPath: 'manuscript/卷一/第二章.md', wordCount: 5 },
      { relPath: 'manuscript/卷二/第三章.md', wordCount: 6 },
    ]);
    // 明细之和等于 total
    expect(res.files!.reduce((s, f) => s + f.wordCount, 0)).toBe(res.total);
  });

  it('给 relPath：只算该章，不含 frontmatter 字数', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/卷一/第一章.md': '---\ntitle: 一\n---\n# 开头\n\n正文十一个字符。',
      'manuscript/卷一/第二章.md': '别的章。',
    });

    expect(wordCount(work, 'manuscript/卷一/第一章.md')).toEqual({ total: 11 });
    expect(wordCount(work, 'manuscript/卷一/第二章.md')).toEqual({ total: 4 });
  });

  it('空作品目录：total 0、files 空数组', () => {
    expect(wordCount(makeWorkDir())).toEqual({ total: 0, files: [] });
  });
});
