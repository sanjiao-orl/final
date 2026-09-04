/** inbox.test.ts —— 裁决收件箱：append 幂等 / adopt 落账+回读验证 / discard 理由枚举 / md round-trip。 */
import { describe, expect, it } from 'vitest';
import { makeProposal, type ProposalOp } from '../src/proposal.js';
import { inboxAdopt, inboxAppend, inboxDiscard, inboxList, verifyTargets } from '../src/inbox.js';
import { emptyLedger, readLedger, writeLedger, type Ledger } from '../src/ledger.js';
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
    // 裁决后不再占 pending 键 → 可再入（「其他」理由不抑制；「误报」的抑制见下方专测）
    inboxDiscard(work, p1.id, { reason: '其他' });
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

describe('裁决语义修复（4.2.1）', () => {
  it('「误报」驳回 → 同键永久抑制再入；「有意延后」→ 重报可再入', () => {
    const work = makeWorkDir();
    seedLedger(work);
    const p1 = makeProposal('scan', [addOp]);
    inboxAppend(work, [p1]);
    inboxDiscard(work, p1.id, { reason: '误报' });
    const r1 = inboxAppend(work, [makeProposal('scan', [addOp])]);
    expect(r1.added).toEqual([]);
    expect(r1.skipped.length).toBe(1);
    expect(r1.outcomes.every((o) => !o.added)).toBe(true);
    const delayed = makeProposal('radar', [{ ...addOp, targetKey: 'P-003' }]);
    inboxAppend(work, [delayed]);
    inboxDiscard(work, delayed.id, { reason: '有意延后', reanchorVolume: '卷三' });
    const r2 = inboxAppend(work, [makeProposal('radar', [{ ...addOp, targetKey: 'P-003' }])]);
    expect(r2.added.length).toBe(1);
  });

  it('终态守卫：adopted/discarded 均不可再裁决', () => {
    const work = makeWorkDir();
    seedLedger(work);
    const p = makeProposal('scan', [addOp]);
    inboxAppend(work, [p]);
    inboxAdopt(work, p.id);
    expect(() => inboxAdopt(work, p.id)).toThrow(/已裁决/);
    expect(() => inboxDiscard(work, p.id, { reason: '误报' })).toThrow(/已裁决/);
  });

  it('保留文件守卫：收件箱不得指向 ledger.md / style.md', () => {
    const work = makeWorkDir();
    seedLedger(work); // 产生 .novel/ledger.md
    expect(() => inboxAppend(work, [makeProposal('scan', [addOp])], '.novel/ledger.md')).toThrow(/保留/);
    expect(() => inboxList(work, '.novel/style.md')).toThrow(/保留/);
  });

  it('回读验证 ❌ → 保持 pending 可改判（自相矛盾提案：同提案 ADD 后 DELETE 同键）', () => {
    const work = makeWorkDir();
    seedLedger(work);
    const addP9: ProposalOp = { ...addOp, targetKey: 'P-009', op: { op: 'promise', entry: { id: 'P-009', name: '雾中诺言', arc: 'planted', setups: [{ chapter: CH, quote: '雾' }], payoffs: [] } } };
    const delP9: ProposalOp = { action: 'DELETE', op: { op: 'remove', dimension: 'promise', id: 'P-009' }, targetKey: 'P-009', evidence: { chapter: CH, quote: 'q' }, rationale: '先加后删的自相矛盾草稿' };
    const p = makeProposal('scan', [addP9, delP9]);
    inboxAppend(work, [p]);
    const r = inboxAdopt(work, p.id);
    expect(r.applied).toBe(true);
    expect(r.verify?.ok).toBe(false);
    expect(r.proposal.status).toBe('pending');
    const list = inboxList(work);
    expect(list[0]!.proposal.status).toBe('pending');
    expect(list[0]!.verify?.ok).toBe(false);
    const d = inboxDiscard(work, p.id, { reason: '其他' });
    expect(d.proposal.status).toBe('discarded');
  });

  it('摘句含定界串/围栏 → 收件箱 round-trip 无损（标记转义+贪婪围栏）', () => {
    const work = makeWorkDir();
    seedLedger(work);
    const tricky: ProposalOp = {
      ...addOp,
      evidence: { chapter: CH, quote: '他念道：<!-- inbox-entry:end --> 然后展示 ```yaml 代码' },
      rationale: '含定界串与围栏的摘句 <!-- inbox-entry:start x -->',
    };
    const p = makeProposal('scan', [tricky]);
    const r = inboxAppend(work, [p]);
    expect(r.added).toEqual([p.id]);
    const list = inboxList(work);
    expect(list.length).toBe(1);
    expect(list[0]!.proposal).toEqual(p);
  });
});

describe('verifyTargets（纯函数，逐维对账真实落点）', () => {
  const L = (): Ledger => ({
    ...emptyLedger(),
    doNotReexplain: ['旧设定'],
    clock: [{ chapters: ['manuscript/第1章.md'] }],
  });
  const delDnr = (fact: string): ProposalOp => ({ action: 'DELETE', op: { op: 'remove', dimension: 'doNotReexplain', item: fact }, targetKey: fact, evidence: { chapter: CH, quote: 'q' }, rationale: 'r' });

  it('登记表 DELETE 对账：在册未删成 → ❌；已消失 → ✅（修复前恒反判）', () => {
    expect(verifyTargets(L(), makeProposal('scan', [delDnr('旧设定')])).ok).toBe(false);
    expect(verifyTargets(emptyLedger(), makeProposal('scan', [delDnr('旧设定')])).ok).toBe(true);
  });

  it('clock 维真实回读：DELETE 后仍在 → ❌；已删 → ✅；upsert 在位 → ✅（修复前恒 ✅ 空转/恒 ❌）', () => {
    const delClock: ProposalOp = { action: 'DELETE', op: { op: 'remove', dimension: 'clock', chapters: ['manuscript/第1章.md'] }, targetKey: 'manuscript/第1章.md', evidence: { chapter: CH, quote: 'q' }, rationale: 'r' };
    expect(verifyTargets(L(), makeProposal('scan', [delClock])).ok).toBe(false);
    expect(verifyTargets(emptyLedger(), makeProposal('scan', [delClock])).ok).toBe(true);
    const upClock: ProposalOp = { action: 'ADD', op: { op: 'clock', entry: { chapters: ['manuscript/第1章.md'] } }, targetKey: 'manuscript/第1章.md', evidence: { chapter: CH, quote: 'q' }, rationale: 'r' };
    expect(verifyTargets(L(), makeProposal('scan', [upClock])).ok).toBe(true);
  });
});

describe('语义预检与 op 级去重（4.2.1 挂账在 4.3 承接）', () => {
  it('UPDATE 目标不在位 → deny 不落账；ADD 键已占用 → deny', () => {
    const work = makeWorkDir();
    seedLedger(work);
    const updGhost: ProposalOp = { action: 'UPDATE', op: { op: 'promise', entry: { id: 'P-404', name: '不存在', arc: 'planted', setups: [], payoffs: [] } }, targetKey: 'P-404', evidence: { chapter: CH, quote: 'q' }, rationale: 'r' };
    const p1 = makeProposal('scan', [updGhost]);
    inboxAppend(work, [p1]);
    const r1 = inboxAdopt(work, p1.id);
    expect(r1.applied).toBe(false);
    expect(r1.denials.join()).toContain('UPDATE 目标不在位');
    const addDup: ProposalOp = { action: 'ADD', op: { op: 'promise', entry: { id: 'P-001', name: '铜哨隐患', arc: 'planted', setups: [], payoffs: [] } }, targetKey: 'P-001', evidence: { chapter: CH, quote: 'q' }, rationale: 'r' };
    const p2 = makeProposal('scan', [addDup]);
    inboxAppend(work, [p2]);
    const r2 = inboxAdopt(work, p2.id);
    expect(r2.applied).toBe(false);
    expect(r2.denials.join()).toContain('ADD 键已占用');
  });

  it('op 级部分入箱：重叠键剔除带明细、新候选照常入箱（不再整提案静默丢）', () => {
    const work = makeWorkDir();
    seedLedger(work);
    const opB: ProposalOp = { ...addOp, targetKey: 'P-003', op: { op: 'promise', entry: { id: 'P-003', name: '新候选', arc: 'planted', setups: [{ chapter: CH, quote: 'q' }], payoffs: [] } } };
    const p1 = makeProposal('scan', [addOp]);
    inboxAppend(work, [p1]); // ADD:P-002 占用 pending 键
    const p2 = makeProposal('scan', [addOp, opB]);
    const r = inboxAppend(work, [p2]);
    expect(r.added).toEqual([p2.id]);
    expect(r.outcomes[0]!.skippedKeys).toEqual(['ADD:P-002']);
    const kept = inboxList(work).find((e) => e.proposal.id === p2.id)!.proposal;
    expect(kept.ops.map((o) => o.targetKey)).toEqual(['P-003']);
  });
});

describe('4.3 评审修复回归', () => {
  it('character 维语义预检：ADD 占用 deny、UPDATE ghost deny；adopt 后回读✅', () => {
    const work = makeWorkDir();
    seedLedger(work);
    const addChar: ProposalOp = { action: 'ADD', op: { op: 'character', entry: { name: '克莱恩' } }, targetKey: '克莱恩', evidence: { chapter: CH, quote: 'q' }, rationale: 'r' };
    const p1 = makeProposal('scan', [addChar]);
    inboxAppend(work, [p1]);
    const r1 = inboxAdopt(work, p1.id);
    expect(r1.applied).toBe(true);
    expect(r1.verify?.ok).toBe(true);
    // 再扫同名 → ADD 键占用 deny（转人工）
    const p2 = makeProposal('scan', [addChar]);
    inboxAppend(work, [p2]);
    const r2 = inboxAdopt(work, p2.id);
    expect(r2.applied).toBe(false);
    expect(r2.denials.join()).toContain('ADD 键已占用');
    // UPDATE ghost deny
    const updGhost: ProposalOp = { action: 'UPDATE', op: { op: 'character', entry: { name: '不存在' } }, targetKey: '不存在', evidence: { chapter: CH, quote: 'q' }, rationale: 'r' };
    const p3 = makeProposal('scan', [updGhost]);
    inboxAppend(work, [p3]);
    const r3 = inboxAdopt(work, p3.id);
    expect(r3.applied).toBe(false);
    expect(r3.denials.join()).toContain('UPDATE 目标不在位');
  });

  it('已观察键：全 NOOP 观察提案 adopt 后不再重报（观察有稳定终态）', () => {
    const work = makeWorkDir();
    seedLedger(work);
    const noopOp: ProposalOp = { action: 'NOOP', op: { op: 'character', entry: { name: '克莱恩' } }, targetKey: '克菜恩', rationale: '观察' };
    const p = makeProposal('scan', [noopOp]);
    inboxAppend(work, [p]);
    const r = inboxAdopt(work, p.id);
    expect(r.applied).toBe(false); // 全 NOOP 零落账
    const again = inboxAppend(work, [makeProposal('scan', [noopOp])]);
    expect(again.added).toEqual([]); // adopted 观察键抑制再入
    expect(again.skipped.length).toBe(1);
  });
});

describe('裁决回路加固（2026-09-05 审计回归）', () => {
  it('损坏块不可裁决：解析失败伪条目（ops 空）adopt 抛错，解析失败留痕不被覆盖', () => {
    const work = makeWorkDir();
    seedLedger(work);
    writeTree(work, {
      '.novel/inbox.md': '# 裁决收件箱\n\n<!-- inbox-entry:start PR-BROKEN -->\n不是合法提案块（缺 front matter）\n<!-- inbox-entry:end -->\n',
    });
    const list = inboxList(work);
    expect(list.length).toBe(1);
    expect(list[0]!.proposal.ops).toEqual([]);
    expect(list[0]!.verify?.ok).toBe(false);
    expect(() => inboxAdopt(work, 'PR-BROKEN')).toThrow(/损坏/);
    expect(inboxList(work)[0]!.verify?.message).toContain('解析失败'); // 失败裁决不抹留痕
  });

  it('全 NOOP 也过写闸：触碰 protect 的观察提案拒绝（快车道无豁免）；不触碰的照常直采纳', () => {
    const work = makeWorkDir();
    seedLedger(work);
    const touch: ProposalOp = { action: 'NOOP', op: { op: 'prop', entry: { name: '主角金手指' } }, targetKey: '主角金手指', rationale: '观察' };
    const p1 = makeProposal('scan', [touch]);
    inboxAppend(work, [p1]);
    const r1 = inboxAdopt(work, p1.id);
    expect(r1.applied).toBe(false);
    expect(r1.denials.join()).toContain('PROTECT');
    expect(r1.proposal.status).toBe('pending');
    const clean: ProposalOp = { action: 'NOOP', op: { op: 'character', entry: { name: '克莱恩' } }, targetKey: '克莱恩', rationale: '观察' };
    const p2 = makeProposal('scan', [clean]);
    inboxAppend(work, [p2]);
    const r2 = inboxAdopt(work, p2.id);
    expect(r2.applied).toBe(false); // 全 NOOP 零落账
    expect(r2.proposal.status).toBe('adopted');
    expect(r2.verify?.ok).toBe(true);
  });

  it('回读❌后改判驳回：❌ 留痕随条目保留（不随 discard 抹掉）', () => {
    const work = makeWorkDir();
    seedLedger(work);
    const addP9: ProposalOp = { ...addOp, targetKey: 'P-009', op: { op: 'promise', entry: { id: 'P-009', name: '雾中诺言', arc: 'planted', setups: [{ chapter: CH, quote: '雾' }], payoffs: [] } } };
    const delP9: ProposalOp = { action: 'DELETE', op: { op: 'remove', dimension: 'promise', id: 'P-009' }, targetKey: 'P-009', evidence: { chapter: CH, quote: 'q' }, rationale: '先加后删的自相矛盾草稿' };
    const p = makeProposal('scan', [addP9, delP9]);
    inboxAppend(work, [p]);
    const r = inboxAdopt(work, p.id);
    expect(r.applied).toBe(true);
    expect(r.verify?.ok).toBe(false);
    inboxDiscard(work, p.id, { reason: '其他' });
    const list = inboxList(work);
    expect(list[0]!.proposal.status).toBe('discarded');
    expect(list[0]!.verify?.ok).toBe(false); // 修复前：discard 重建条目丢 verify
  });
});
