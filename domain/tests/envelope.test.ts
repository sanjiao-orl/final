/** envelope.test.ts —— 信封区间代数 + 双读零 diff round-trip（reference/05 §断言先行）。 */
import { describe, expect, it } from 'vitest';
import { dualReadRoundTrip, factsToLedger, intervalActiveAt, intervalContains, intervalExpiredAt, intervalsOverlap, ledgerToFacts } from '../src/envelope.js';
import { emptyLedger, type Ledger } from '../src/ledger.js';

const ORDER = Array.from({ length: 30 }, (_, i) => ({ relPath: `manuscript/正文/${String(i + 1).padStart(4, '0')}-第${i + 1}章.md`, title: `第${i + 1}章` }));

describe('区间代数（确定性）', () => {
  const a = { from: 3, to: 10 };
  it('包含：闭合区间', () => {
    expect(intervalContains(a, { from: 4, to: 9 })).toBe(true);
    expect(intervalContains(a, { from: 4, to: 11 })).toBe(false);
    expect(intervalContains(a, { from: 3, to: 10 })).toBe(true);
  });
  it('包含：开放端视为 +∞', () => {
    expect(intervalContains({ from: 1, to: null }, a)).toBe(true);
    expect(intervalContains(a, { from: 11, to: null })).toBe(false);
  });
  it('重叠：共享至少一章；相邻不算', () => {
    expect(intervalsOverlap(a, { from: 10, to: 20 })).toBe(true);
    expect(intervalsOverlap(a, { from: 11, to: 20 })).toBe(false);
    expect(intervalsOverlap({ from: 1, to: null }, { from: 999, to: null })).toBe(true);
  });
  it('生效/失效：开放端持续生效；过期≠矛盾', () => {
    expect(intervalActiveAt(a, 3)).toBe(true);
    expect(intervalActiveAt(a, 11)).toBe(false);
    expect(intervalActiveAt({ from: 1, to: null }, 1000)).toBe(true);
    expect(intervalExpiredAt(a, 11)).toBe(true);
    expect(intervalExpiredAt(a, 10)).toBe(false);
    expect(intervalExpiredAt({ from: 1, to: null }, 1000)).toBe(false);
  });
});

describe('双读归一化（ledger ⇄ envelopes）', () => {
  const ledger: Ledger = {
    ...emptyLedger(),
    clock: [{ chapters: ['manuscript/正文/0005-第5章.md', 'manuscript/正文/0007-第7章.md'], storyDay: '第2日:夜', thread: '主线' }],
    props: [
      {
        name: '铜哨',
        holder: '克莱恩',
        status: '封存',
        custody: [
          { chapter: 'manuscript/正文/0003-第3章.md', holder: '考普斯蒂', quote: '铜哨' },
          { chapter: 'manuscript/正文/0009-第9章.md', holder: '克莱恩' },
        ],
      },
    ],
    promises: [
      { id: 'P-001', name: '铜哨隐患', arc: 'planted', setups: [{ chapter: 'manuscript/正文/0003-第3章.md', quote: '收下铜哨' }], payoffs: [] },
      { id: 'P-002', name: '已回收伏笔', arc: 'resolved', setups: [{ chapter: 'manuscript/正文/0002-第2章.md' }], payoffs: [{ chapter: 'manuscript/正文/0012-第12章.md' }] },
    ],
    knowledge: [
      { character: '克莱恩', knows: [{ fact: '值夜者存在', since: 'manuscript/正文/0002-第2章.md' }, { fact: '序列体系', since: 'manuscript/正文/0006-第6章.md' }] },
    ],
    protect: [{ item: '主角金手指', reason: '设定核心' }],
    tripwires: ['铜哨不得被当普通哨子吹'],
    doNotReexplain: ['灰雾之上'],
  };

  it('round-trip 零 diff（payload 无损投影）', () => {
    expect(dualReadRoundTrip(ledger, ORDER)).toBe(true);
  });

  it('区间语义：promise resolved 闭合、planted 开放；prop 开放；clock 跨度闭合', () => {
    const facts = ledgerToFacts(ledger, ORDER);
    const p1 = facts.find((f) => f.key === 'P-001')!;
    const p2 = facts.find((f) => f.key === 'P-002')!;
    const prop = facts.find((f) => f.type === 'prop')!;
    const clock = facts.find((f) => f.type === 'clock')!;
    expect(p1.interval).toEqual({ from: 3, to: null });
    expect(p1.face).toBe('appendable');
    expect(p2.interval).toEqual({ from: 2, to: 12 });
    expect(p2.face).toBe('frozen');
    expect(prop.interval).toEqual({ from: 3, to: null });
    expect(clock.interval).toEqual({ from: 5, to: 7 });
  });

  it('knowledge 区间=最早 since；evidence 随 knows', () => {
    const facts = ledgerToFacts(ledger, ORDER);
    const k = facts.find((f) => f.type === 'knowledge')!;
    expect(k.interval.from).toBe(2);
    expect(k.evidence.length).toBe(2);
  });

  it('空账本与三张登记表：facts 不含登记表，投影直传不丢', () => {
    expect(ledgerToFacts(emptyLedger(), ORDER)).toEqual([]);
    const back = factsToLedger(ledgerToFacts(ledger, ORDER), ledger);
    expect(back.protect).toEqual(ledger.protect);
    expect(back.tripwires).toEqual(ledger.tripwires);
    expect(back.doNotReexplain).toEqual(ledger.doNotReexplain);
  });
});
