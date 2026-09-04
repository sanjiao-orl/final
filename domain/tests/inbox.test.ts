/** inbox.test.ts —— 裁决收件箱：append 幂等 / adopt 落账+回读验证 / discard 理由枚举 / md round-trip。 */
import { describe, expect, it } from 'vitest';
import { makeProposal, type ProposalOp } from '../src/proposal.js';
import { inboxAdopt, inboxAppend, inboxDiscard, inboxList } from '../src/inbox.js';
import { emptyLedger, readLedger, writeLedger } from '../src/ledger.js';
import { makeWorkDir, writeTree } from './helpers.js';

const CH = 'manuscript/第3章.md';

function seedLedger(work: string): void {
  writeTree(work, { [CH]: '---\ntitle: 第3章\n---\n正文。' });
  writeLedger(work, {
    ...emptyLedger(),
    promises: [{ id: 'P-001', name: '铜哨隐患', arc: 'planted', setups: [{ chapter: CH, quote: '收下铜哨' }], payoffs: [] }],
    protect: [{ item: '主角金手指', reason: '设定核心' }],
  });
}

const addOp: ProposalOp = {
  action: 'ADD',
  op: { op: 'promise', entry: { id: 'P-002', name: '灰雾秘密', arc: 'planted', setups: [{ chapter: CH, quote: '灰雾' }], payoffs: [] } },
  targetKey: 'P-002',
  evidence: { chapter: CH, quote: '灰雾之上' },
  rationale: '第3章埋设',
};

describe('收件箱存储与幂等', () => {
  it('append→list round-trip；同 (action,targetKey) 的 pending 去重', () => {
    const work = makeWorkDir();
    seedLedger(work);
    const p1 = makeProposal('scan', [addOp]);
    const r1 = inboxAppend(work, [p1]);
    expect(r1.added).toEqual([p1.id]);
    // 另一个 id 但同 targetKey+action 的 pending → skip
    const p2 = makeProposal('radar', [addOp]);
    const r2 = inboxAppend(work, [p2]);
    expect(r2.added).toEqual([]);
    expect(r2.skipped).toEqual([p2.id]);
    // 裁决后不再占 pending 键 → 可再入
    inboxDiscard(work, p1.id, { reason: '误报' });
    const r3 = inboxAppend(work, [p2]);
    expect(r3.added).toEqual([p2.id]);
    const list = inboxList(work);
    expect(list.length).toBe(2);
    expect(list.map((e) => e.proposal.status).sort()).toEqual(['discarded', 'pending']);
  });

  it('路径守卫：非 .novel/ 根下 .md 拒绝', () => {
    const work = makeWorkDir();
    expect(() => inboxAppend(work, [makeProposal('scan', [addOp])], 'editorial_notes/inbox.md')).toThrow(/\.novel/);
    expect(() => inboxList(work, '.novel/sub/inbox.md')).toThrow(/\.novel/);
  });
});

describe('裁决：adopt 落账+回读验证', () => {
  it('adopt 后账本条目在位、验证 ✅、块置 adopted', () => {
    const work = makeWorkDir();
    seedLedger(work);
    const p = makeProposal('scan', [addOp]);
    inboxAppend(work, [p]);
    const r = inboxAdopt(work, p.id);
    expect(r.applied).toBe(true);
    expect(r.verify?.ok).toBe(true);
    expect(r.proposal.status).toBe('adopted');
    const { ledger } = readLedger(work);
    expect(ledger.promises.some((x) => x.id === 'P-002')).toBe(true);
    // 持久化：重新 list 仍见 adopted + verify
    const list = inboxList(work);
    expect(list[0]!.proposal.status).toBe('adopted');
    expect(list[0]!.verify?.ok).toBe(true);
  });

  it('protect 写闸：触碰后 adopt 拒绝且不落账', () => {
    const work = makeWorkDir();
    seedLedger(work);
    const touch: ProposalOp = {
      action: 'UPDATE',
      op: { op: 'prop', entry: { name: '主角金手指', holder: 'x', custody: [{ chapter: CH }] } },
      targetKey: '主角金手指',
      evidence: { chapter: CH, quote: 'q' },
      rationale: '试图改动',
    };
    const p = makeProposal('chat', [touch]);
    inboxAppend(work, [p]);
    const r = inboxAdopt(work, p.id);
    expect(r.applied).toBe(false);
    expect(r.denials.join()).toContain('PROTECT');
    expect(r.proposal.status).toBe('pending'); // 状态不变，可改提案后再裁
  });

  it('DELETE 采纳后回读验证「消失」', () => {
    const work = makeWorkDir();
    seedLedger(work);
    const del: ProposalOp = {
      action: 'DELETE',
      op: { op: 'remove', dimension: 'promise', id: 'P-001' },
      targetKey: 'P-001',
      evidence: { chapter: CH, quote: '作者撤线' },
      rationale: '作者确认此伏笔作废',
    };
    const p = makeProposal('scan', [del]);
    inboxAppend(work, [p]);
    const r = inboxAdopt(work, p.id);
    expect(r.applied).toBe(true);
    expect(r.verify?.ok).toBe(true);
    const { ledger } = readLedger(work);
    expect(ledger.promises.some((x) => x.id === 'P-001')).toBe(false);
  });

  it('discard 必带理由；有意延后带新预计卷（卷锚重报依据持久化）', () => {
    const work = makeWorkDir();
    seedLedger(work);
    const p = makeProposal('radar', [addOp]);
    inboxAppend(work, [p]);
    const r = inboxDiscard(work, p.id, { reason: '有意延后', reanchorVolume: '卷三', note: '等读者先忘记' });
    expect(r.proposal.status).toBe('discarded');
    expect(r.proposal.resolution?.dismiss).toEqual({ reason: '有意延后', note: '等读者先忘记', reanchorVolume: '卷三' });
    const list = inboxList(work);
    expect(list[0]!.proposal.resolution?.dismiss?.reanchorVolume).toBe('卷三');
  });

  it('未知提案 id 报错', () => {
    const work = makeWorkDir();
    seedLedger(work);
    expect(() => inboxAdopt(work, 'PR-NOPE')).toThrow(/无此提案/);
  });
});
