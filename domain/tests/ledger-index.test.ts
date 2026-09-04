/** ledger-index.test.ts —— 最小索引层：区间裁剪切片压预算、倒排查询确定性（reference/05 §断言先行）。 */
import { describe, expect, it } from 'vitest';
import { buildLedgerIndex, DEFAULT_SLICE_BUDGET, indexedSliceFromIndex, indexStats, queryByName } from '../src/ledger-index.js';
import { intervalActiveAt } from '../src/envelope.js';
import { emptyLedger, type Ledger } from '../src/ledger.js';

const ch = (n: number) => `manuscript/正文/${String(n).padStart(4, '0')}-第${n}章.md`;
const ORDER = Array.from({ length: 30 }, (_, i) => ({ relPath: ch(i + 1), title: `第${i + 1}章` }));

function richLedger(): Ledger {
  return {
    ...emptyLedger(),
    clock: [{ chapters: [ch(5), ch(7)], storyDay: '第2日:夜', thread: '主线' }],
    props: [
      { name: '铜哨', holder: '克莱恩', status: '封存', tripwire: '不得被当普通哨子吹', custody: [{ chapter: ch(3), holder: '考普斯蒂', quote: '收下铜哨' }, { chapter: ch(9), holder: '克莱恩' }] },
      ...Array.from({ length: 400 }, (_, i) => ({ name: `道具${i}`, holder: '某人', status: '在库', custody: [{ chapter: ch(i % 30 + 1), holder: '某人' }] })),
    ],
    promises: [
      { id: 'P-001', name: '铜哨隐患', arc: 'planted', setups: [{ chapter: ch(3), quote: '收下铜哨' }], payoffs: [], due: 20 },
      { id: 'P-002', name: '旧案伏笔', arc: 'resolved', setups: [{ chapter: ch(2) }], payoffs: [{ chapter: ch(12) }] },
      ...Array.from({ length: 600 }, (_, i) => ({ id: `PX-${i}`, name: `伏笔${i}`, arc: 'planted' as const, setups: [{ chapter: ch(i % 30 + 1) }], payoffs: [] })),
    ],
    knowledge: [
      { character: '克莱恩', knows: [{ fact: '值夜者存在', since: ch(2) }, { fact: '序列体系', since: ch(6) }] },
      ...Array.from({ length: 200 }, (_, i) => ({ character: `角色${i}`, knows: [{ fact: `事实${i}`, since: ch(i % 30 + 1) }] })),
    ],
  };
}

describe('区间裁剪切片', () => {
  it('只注入 order 生效条目：resolved 伏笔在 payoff 后不再出现', () => {
    const idx = buildLedgerIndex(richLedger(), ORDER);
    const at15 = indexedSliceFromIndex(idx, 15);
    const text = at15.lines.join('\n');
    expect(text).not.toContain('旧案伏笔'); // 2→12 闭合，15 已失效
    expect(text).toContain('铜哨隐患'); // 开放端持续
  });
  it('预算裁剪：超预算条目被丢弃且 dropped 计数如实', () => {
    const idx = buildLedgerIndex(richLedger(), ORDER);
    const small = indexedSliceFromIndex(idx, 9, 2000);
    expect(small.chars).toBeLessThanOrEqual(2000);
    expect(small.dropped).toBeGreaterThan(0);
    expect(small.lines.length).toBeGreaterThan(0);
    // 承重优先：预算紧张时伏笔线保留、时钟最先出局
    expect(small.lines.some((l) => l.startsWith('[伏笔]'))).toBe(true);
    const big = indexedSliceFromIndex(idx, 9, DEFAULT_SLICE_BUDGET);
    expect(big.dropped).toBeLessThan(small.dropped);
  });
  it('composition 如实计数（注入可见性）', () => {
    const idx = buildLedgerIndex(richLedger(), ORDER);
    const s = indexedSliceFromIndex(idx, 9, 8000);
    const sum = Object.values(s.composition).reduce((a, b) => a + b, 0);
    expect(sum).toBe(s.lines.length);
  });
  it('大账本切片实测压进预算（44 万字符问题的解法验证）', () => {
    const idx = buildLedgerIndex(richLedger(), ORDER);
    const s = indexedSliceFromIndex(idx, 15, DEFAULT_SLICE_BUDGET);
    expect(s.chars).toBeLessThanOrEqual(DEFAULT_SLICE_BUDGET);
  });
});

describe('名字倒排', () => {
  it('主名查询命中且区间过滤正确', () => {
    const idx = buildLedgerIndex(richLedger(), ORDER);
    const all = queryByName(idx, '铜哨');
    expect(all.length).toBe(1);
    const at2 = queryByName(idx, '铜哨', 2); // 首个托管章是 3
    expect(at2.length).toBe(0);
    const at3 = queryByName(idx, '铜哨', 3);
    expect(at3.length).toBe(1);
  });
  it('伏笔 id 可查；knowledge 角色可查', () => {
    const idx = buildLedgerIndex(richLedger(), ORDER);
    expect(queryByName(idx, 'P-001').length).toBe(1);
    const k = queryByName(idx, '克莱恩', 6);
    expect(k.length).toBe(1);
    expect(k[0]!.type).toBe('knowledge');
  });
  it('规范化：大小写/空白不敏感', () => {
    const idx = buildLedgerIndex(richLedger(), ORDER);
    expect(queryByName(idx, ' 铜哨 ').length).toBe(1);
  });
  it('索引统计', () => {
    const st = indexStats(buildLedgerIndex(richLedger(), ORDER));
    expect(st.facts).toBe(4 + 400 + 600 + 201); // clock1+prop1+promise2 之外：400 道具+600 伏笔+201 角色（克莱恩+200 合成）
    expect(st.nameKeys).toBeGreaterThan(1000);
    expect(st.openIntervals).toBeGreaterThan(0);
  });
  it('区间代数与切片一致（activeAt 抽查）', () => {
    const idx = buildLedgerIndex(richLedger(), ORDER);
    const p2 = queryByName(idx, 'P-002')[0]!;
    expect(intervalActiveAt(p2.interval, 12)).toBe(true);
    expect(intervalActiveAt(p2.interval, 13)).toBe(false);
  });
});

describe('角色卡索引（4.3）', () => {
  it('主名+别名入倒排；配额内随切片注入并计入 composition', () => {
    const ledger: Ledger = { ...emptyLedger(), characters: [{ name: '克莱恩', aliases: ['世界'], role: '值夜者', states: [{ field: '位置', value: '贝克兰德', since: ch(3) }] }] };
    const idx = buildLedgerIndex(ledger, ORDER);
    expect(queryByName(idx, '克莱恩').length).toBe(1);
    expect(queryByName(idx, '世界').length).toBe(1);
    const cut = indexedSliceFromIndex(idx, 5, DEFAULT_SLICE_BUDGET);
    expect(cut.composition.character).toBe(1);
    expect(cut.lines.some((l) => l.startsWith('[角色] 克莱恩'))).toBe(true);
  });
});
