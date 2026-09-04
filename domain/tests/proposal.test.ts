/** proposal.test.ts —— 提案机器：序列化 round-trip / 应用幂等 / 权限面写闸（reference/05 §断言先行）。 */
import { describe, expect, it } from 'vitest';
import { adoptProposal, applyProposal, discardProposal, makeProposal, parseProposal, serializeProposal, validateProposal, type ProposalOp } from '../src/proposal.js';
import { emptyLedger, type Ledger } from '../src/ledger.js';

const CH = 'manuscript/正文/0005-第5章.md';

function baseLedger(): Ledger {
  return {
    ...emptyLedger(),
    props: [{ name: '铜哨', holder: '考普斯蒂', custody: [{ chapter: CH, holder: '考普斯蒂', quote: '铜哨' }] }],
    protect: [{ item: '铜哨', reason: '作者刻意保留的隐患道具' }],
    promises: [{ id: 'P-001', name: '铜哨隐患', arc: 'planted', setups: [{ chapter: CH, quote: '收下' }], payoffs: [] }],
  };
}

const addPromise: ProposalOp = {
  action: 'ADD',
  op: { op: 'promise', entry: { id: 'P-002', name: '灰雾之上秘密', arc: 'planted', setups: [{ chapter: CH, quote: '灰雾' }], payoffs: [] } },
  targetKey: 'P-002',
  evidence: { chapter: CH, line: 42, quote: '灰雾之上' },
  rationale: '第5章埋设，后文反复回收',
};
const touchProtect: ProposalOp = {
  action: 'UPDATE',
  op: { op: 'prop', entry: { name: '铜哨', holder: '克莱恩', custody: [{ chapter: CH, holder: '克莱恩' }] } },
  targetKey: '铜哨',
  evidence: { chapter: CH, quote: '交还铜哨' },
  rationale: '持有者变更',
};

describe('权限面校验（写闸）', () => {
  it('protect 触碰 → deny', () => {
    const p = makeProposal('scan', [touchProtect]);
    const v = validateProposal(p, baseLedger());
    expect(v.ok).toBe(false);
    expect(v.denials[0]).toContain('PROTECT');
  });
  it('摘由/证据锚缺失 → deny；NOOP 豁免', () => {
    const bad: ProposalOp = { action: 'ADD', op: addPromise.op, targetKey: 'P-002', rationale: '' };
    const v = validateProposal(makeProposal('scan', [bad]), baseLedger());
    expect(v.ok).toBe(false);
    expect(v.denials.join()).toContain('摘由');
    expect(v.denials.join()).toContain('证据锚');
    const noop: ProposalOp = { action: 'NOOP', op: addPromise.op, targetKey: 'P-002', rationale: '观察' };
    expect(validateProposal(makeProposal('scan', [noop]), baseLedger()).ok).toBe(true);
  });
  it('空操作序列 → deny', () => {
    expect(validateProposal(makeProposal('scan', []), baseLedger()).ok).toBe(false);
  });
});

describe('应用管线', () => {
  it('合法提案应用后落账；幂等=upsert 键语义（重复应用账本不变、不重复登记）', () => {
    const p = adoptProposal(makeProposal('scan', [addPromise]));
    const r1 = applyProposal(baseLedger(), p);
    expect(r1.applied).toBe(true);
    expect(r1.ledger.promises.some((x) => x.id === 'P-002')).toBe(true);
    const r2 = applyProposal(r1.ledger, p);
    expect(r2.applied).toBe(true);
    expect(JSON.stringify(r2.ledger)).toBe(JSON.stringify(r1.ledger));
    expect(r2.ledger.promises.filter((x) => x.id === 'P-002').length).toBe(1);
  });
  it('写闸命中 → 不应用，账本原样', () => {
    const r = applyProposal(baseLedger(), makeProposal('chat', [touchProtect]));
    expect(r.applied).toBe(false);
    expect(r.ledger.props[0]!.holder).toBe('考普斯蒂');
    expect(r.denials.length).toBeGreaterThan(0);
  });
  it('全 NOOP → 不应用', () => {
    const noop: ProposalOp = { action: 'NOOP', op: addPromise.op, targetKey: 'x', rationale: '观察' };
    const r = applyProposal(baseLedger(), makeProposal('radar', [noop]));
    expect(r.applied).toBe(false);
  });
});

describe('裁决状态机', () => {
  it('dismiss 必带理由枚举；有意延后带新预计卷', () => {
    const p = discardProposal(makeProposal('radar', [addPromise]), { reason: '有意延后', reanchorVolume: '卷三' });
    expect(p.status).toBe('discarded');
    expect(p.resolution?.dismiss?.reason).toBe('有意延后');
    expect(p.resolution?.dismiss?.reanchorVolume).toBe('卷三');
  });
});

describe('md 序列化 round-trip', () => {
  it('serialize → parse 深相等（含裁决记录）', () => {
    const p = discardProposal(makeProposal('scan', [addPromise]), { reason: '误报', note: '同场景多物' });
    const back = parseProposal(serializeProposal(p));
    expect(back).toEqual(p);
  });
  it('pending 态 round-trip', () => {
    const p = makeProposal('import', [addPromise, touchProtect]);
    expect(parseProposal(serializeProposal(p))).toEqual(p);
  });
});
