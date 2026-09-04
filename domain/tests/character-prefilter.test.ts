/** character-prefilter.test.ts —— 角色维确定性预筛：词典提及/超域疑似/写法变体（reference/05 §角色维；4.3）。 */
import { describe, expect, it } from 'vitest';
import { characterPrefilter, prefilterCharacters } from '../src/character-prefilter.js';
import { emptyLedger, type CharacterEntry } from '../src/ledger.js';
import { makeWorkDir, writeTree } from './helpers.js';

const DICT: CharacterEntry[] = [
  { name: '克莱恩', aliases: ['世界'] },
  { name: '老尼尔' },
];

const BODY = '克莱恩推开门。老尼尔正在擦拭铜哨。「世界」是他的另一个名字。齐夏忽然出现。齐夏开口说话。齐夏笑了起来。克菜恩是他的化名。';

describe('prefilterCharacters（纯函数）', () => {
  it('已知名/别名提及计数（含引号内别名）', () => {
    const r = prefilterCharacters(BODY, DICT);
    const klein = r.mentions.find((m) => m.name === '克莱恩');
    expect(klein).toBeDefined();
    expect(klein!.count).toBe(2); // 克莱恩×1（克菜恩是变体非命中）+ 世界×1
    const neal = r.mentions.find((m) => m.name === '老尼尔');
    expect(neal?.count).toBe(1);
  });

  it('超域疑似：高频未命中候选显式计数（不静默丢弃），低频被门槛滤掉', () => {
    const r = prefilterCharacters(BODY, DICT, { minCount: 3 });
    const qixia = r.unknownCandidates.find((c) => c.name === '齐夏');
    expect(qixia).toBeDefined();
    expect(qixia!.count).toBeGreaterThanOrEqual(3);
  });

  it('同一人多写法：编辑距离 1 未登记写法入嫌疑', () => {
    const r = prefilterCharacters(BODY, DICT);
    expect(r.variantSuspects.some((s) => s.variant === '克菜恩' && s.likely === '克莱恩')).toBe(true);
  });
});

describe('characterPrefilter（workDir）', () => {
  it('逐章扫描并聚合；非 manuscript 章拒绝', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第1章.md': '---\ntitle: 1\n---\n克莱恩出现了。克莱恩说话。',
      'manuscript/第2章.md': '---\ntitle: 2\n---\n克莱恩继续。齐夏出场。齐夏说话。齐夏离开。',
    });
    const r = characterPrefilter(work, { ledger: { ...emptyLedger(), characters: DICT }, chapterOrder: [{ relPath: 'manuscript/第1章.md', title: '1' }, { relPath: 'manuscript/第2章.md', title: '2' }] });
    expect(r.scanned).toBe(2);
    expect(r.mentions[0]!.name).toBe('克莱恩');
    expect(r.mentions[0]!.chapters).toEqual(['manuscript/第1章.md', 'manuscript/第2章.md']);
    expect(() => characterPrefilter(work, { chapterRelPaths: ['.novel/ledger.md'], ledger: { ...emptyLedger(), characters: DICT }, chapterOrder: [] })).toThrow(/manuscript/);
  });
});

describe('4.3 评审修复回归', () => {
  it('跨章聚合：每章 1 次共 3 次的配角过聚合门槛（修复前逐章先行滤掉永不入选）', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第1章.md': '---\ntitle: 1\n---\n齐夏出场。',
      'manuscript/第2章.md': '---\ntitle: 2\n---\n齐夏说话。',
      'manuscript/第3章.md': '---\ntitle: 3\n---\n齐夏离开。',
    });
    const r = characterPrefilter(work, { ledger: { ...emptyLedger(), characters: DICT }, chapterOrder: [
      { relPath: 'manuscript/第1章.md', title: '1' },
      { relPath: 'manuscript/第2章.md', title: '2' },
      { relPath: 'manuscript/第3章.md', title: '3' },
    ] });
    expect(r.unknownCandidates.find((c) => c.name === '齐夏')?.count).toBeGreaterThanOrEqual(3);
  });
});
