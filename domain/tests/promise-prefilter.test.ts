/** promise-prefilter.test.ts —— 承诺·伏笔确定性预筛：句式命中/账本关联/未登记候选（超域规约）。 */
import { describe, expect, it } from 'vitest';
import { prefilterChapter, promisePrefilter } from '../src/promise-prefilter.js';
import { emptyLedger, type Ledger } from '../src/ledger.js';
import { makeWorkDir, writeTree } from './helpers.js';

const ledger: Ledger = {
  ...emptyLedger(),
  promises: [
    { id: 'P-001', name: '铜哨隐患', arc: 'planted', setups: [], payoffs: [] },
    { id: 'P-002', name: '报答老尼尔之恩', arc: 'planted', setups: [], payoffs: [] },
  ],
};

describe('prefilterChapter（纯函数）', () => {
  it('嫌疑句式命中并记录行号/谓词', () => {
    const body = '第一章正文。\n他答应过要把铜哨交给值夜者。\n普通叙述行。\n克莱恩发誓一定要找到真相。';
    const hits = prefilterChapter(body, ledger);
    expect(hits.length).toBe(2);
    expect(hits[0]!.line).toBe(2);
    expect(hits[0]!.predicate).toBe('答应');
    expect(hits[1]!.predicate).toBe('发誓');
  });

  it('账本关联：句含已登记承诺名 → matchedPromiseIds 非空', () => {
    const body = '\n他要报答老尼尔之恩，此事不能忘。';
    const hits = prefilterChapter(body, ledger);
    expect(hits[0]!.matchedPromiseIds).toContain('P-002');
  });

  it('未登记候选：命中嫌疑但无账本关联（超域规约显式存在）', () => {
    const body = '\n改天一起去教堂。';
    const hits = prefilterChapter(body, ledger);
    expect(hits[0]!.matchedPromiseIds).toEqual([]);
  });

  it('无嫌疑正文 → 零命中', () => {
    expect(prefilterChapter('正常的叙述与对话。', ledger)).toEqual([]);
  });
});

describe('promisePrefilter（workDir）', () => {
  it('只列有嫌疑的章；扫描数与对照基数如实；非 manuscript 章拒绝', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第1章.md': '---\ntitle: 1\n---\n他许诺要偿还欠下的债。',
      'manuscript/第2章.md': '---\ntitle: 2\n---\n平淡的一章。',
    });
    const r = promisePrefilter(work, { ledger, chapterOrder: [{ relPath: 'manuscript/第1章.md', title: '1' }, { relPath: 'manuscript/第2章.md', title: '2' }] });
    expect(r.scanned).toBe(2);
    expect(r.registeredPromises).toBe(2);
    expect(r.chapters.length).toBe(1);
    expect(r.chapters[0]!.chapterRelPath).toBe('manuscript/第1章.md');
    expect(r.chapters[0]!.hits.length).toBeGreaterThan(0);
    expect(() => promisePrefilter(work, { chapterRelPaths: ['.novel/ledger.md'], ledger, chapterOrder: [] })).toThrow(/manuscript/);
  });
});
