/**
 * proposal.ts —— 提案机器（reference/05 §裁决回路；4.1 地基批第一刀，纯加法、无消费者、无 UI）。
 *
 * 提案 = 带条目 id 的操作序列（ADD/UPDATE/DELETE/NOOP + 证据锚 + 摘由），应用走既有 upsert
 * 管线（applyOps/CAS/快照复用，本模块不重写账本写路径）。统一裁决收件箱的状态机在此定契约：
 * pending → adopted/discarded；dismiss 必带理由枚举（「有意延后」一等公民）。
 *
 * 权限面校验（写闸）：protect 登记项被提案触碰 → deny（拦档，不进收件箱、不落账）。
 * 既有红线：LLM 提案作者裁决——本模块只产机器态，不替作者做 adopted 决定。
 */
import { randomBytes } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { applyOps, type Ledger, type LedgerOp } from './ledger.js';

/** 提案操作动作（外-b4 操作原语：带 id 的操作序列）。 */
export type ProposalAction = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';

/** 证据锚（与信封 FactEvidence 同构；ADD/UPDATE/DELETE 必带）。 */
export interface ProposalEvidence {
  chapter: string;
  line?: number;
  quote?: string;
}

/** 单条提案操作：动作 + 账本操作 + 目标条目自然键 + 证据锚 + 摘由。 */
export interface ProposalOp {
  action: ProposalAction;
  /** 映射到既有 LedgerOp（DELETE 映射 remove；NOOP 携带 op 但应用时跳过）。 */
  op: LedgerOp;
  /** 目标条目自然键（promise=id / knowledge=character / prop=name / clock=chapters 串）。 */
  targetKey: string;
  evidence?: ProposalEvidence;
  rationale: string;
}

/** 提案来源（写入提案与预警=反向提案同构，共用同一台状态机）。 */
export type ProposalOrigin = 'scan' | 'chat' | 'radar' | 'import';

/** 裁决状态（统一裁决收件箱：pending → adopted/discarded）。 */
export type ProposalStatus = 'pending' | 'adopted' | 'discarded';

/** dismiss 理由枚举（必带；「有意延后」一等公民——选后改锚新预计卷）。 */
export type DismissReason = '误报' | '有意延后' | '已知情报' | '其他';

export interface ProposalDismiss {
  reason: DismissReason;
  note?: string;
  /** reason=有意延后时的新预计卷（卷锚重报依据）。 */
  reanchorVolume?: string;
}

export interface Proposal {
  id: string;
  origin: ProposalOrigin;
  createdAt: string;
  ops: ProposalOp[];
  status: ProposalStatus;
  /** 裁决记录（dismiss 时必填理由；adopted 时可空）。 */
  resolution?: { decidedAt: string; dismiss?: ProposalDismiss };
}

/** 权限面校验结果：denials 非空=被写闸拦截（不应用、不进收件箱）。 */
export interface ProposalValidation {
  ok: boolean;
  denials: string[];
}

export function newProposalId(): string {
  return `PR-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(3).toString('hex')}`;
}

/** 新建待裁决提案。 */
export function makeProposal(origin: ProposalOrigin, ops: ProposalOp[]): Proposal {
  return { id: newProposalId(), origin, createdAt: new Date().toISOString(), ops, status: 'pending' };
}

/** protect 触碰检测：op 的目标名是否命中 protect 登记项（写闸=拦）。 */
function protectHit(protectItems: string[], op: LedgerOp): string | null {
  const hay: string[] = [];
  if ('entry' in op) {
    const e = op.entry as unknown as Record<string, unknown>;
    if (typeof e.name === 'string') hay.push(e.name);
    if (typeof e.character === 'string') hay.push(e.character);
    if (typeof e.id === 'string') hay.push(e.id);
  }
  if ('item' in op && typeof op.item === 'string') hay.push(op.item);
  if ('name' in op && typeof (op as { name?: unknown }).name === 'string') hay.push((op as { name: string }).name);
  for (const h of hay) {
    for (const p of protectItems) {
      if (p && (h.includes(p) || p.includes(h))) return p;
    }
  }
  return null;
}

/**
 * validateProposal：权限面校验（纯函数）。
 * - 写闸：任一 op 触碰 protect 登记项 → deny；
 * - 证据闸：ADD/UPDATE/DELETE 缺摘由或证据锚 → deny（提案可追溯性）；
 * - NOOP 不设证据要求（观察性操作）。
 */
export function validateProposal(proposal: Proposal, ledger: Ledger): ProposalValidation {
  const denials: string[] = [];
  const protectItems = ledger.protect.map((p) => p.item).filter(Boolean);
  for (const pop of proposal.ops) {
    const hit = protectHit(protectItems, pop.op);
    if (hit) denials.push(`写闸：操作目标触碰 PROTECT 登记项「${hit}」（${pop.targetKey}）`);
    if (pop.action !== 'NOOP') {
      if (!pop.rationale?.trim()) denials.push(`摘由缺失（${pop.targetKey}）`);
      if (!pop.evidence?.chapter) denials.push(`证据锚缺失（${pop.targetKey}）`);
    }
  }
  if (proposal.ops.length === 0) denials.push('空操作序列');
  return { ok: denials.length === 0, denials };
}

/** 应用结果：applied=false 时 ledger 原样返回（denials 说明原因）。 */
export interface ProposalApplyResult {
  ledger: Ledger;
  applied: boolean;
  denials: string[];
}

/**
 * applyProposal：裁决 adopted 后的应用入口（幂等来自 applyOps 的键 upsert 语义——同一提案
 * 重复应用得到相同账本，不重复登记；无「已应用」持久标记，重复应用由 upsert 判重吸收）。
 * 校验不过（写闸/证据闸）→ 不应用，denials 回传；消费端（4.2 收件箱）据此拦在收件箱外。
 */
export function applyProposal(ledger: Ledger, proposal: Proposal): ProposalApplyResult {
  const v = validateProposal(proposal, ledger);
  if (!v.ok) return { ledger, applied: false, denials: v.denials };
  const ops = proposal.ops.filter((p) => p.action !== 'NOOP').map((p) => p.op);
  if (ops.length === 0) return { ledger, applied: false, denials: ['无有效操作（全 NOOP）'] };
  return { ledger: applyOps(ledger, ops), applied: true, denials: [] };
}

/** 裁决：采纳（返回带裁决记录的新提案对象；应用由调用方决定时机）。 */
export function adoptProposal(proposal: Proposal): Proposal {
  return { ...proposal, status: 'adopted', resolution: { decidedAt: new Date().toISOString() } };
}

/** 裁决：驳回（必带理由枚举；有意延后可带新预计卷=卷锚重报依据）。 */
export function discardProposal(proposal: Proposal, dismiss: ProposalDismiss): Proposal {
  return { ...proposal, status: 'discarded', resolution: { decidedAt: new Date().toISOString(), dismiss } };
}

// ---------- md 序列化（人审内容留 md；收件箱 4.2 落 UI，此处定契约） ----------

/** 提案序列化为 md（front matter 元数据 + YAML 操作序列，作者可直接阅读）。 */
export function serializeProposal(p: Proposal): string {
  const fm = {
    id: p.id,
    origin: p.origin,
    status: p.status,
    createdAt: p.createdAt,
    ...(p.resolution ? { decidedAt: p.resolution.decidedAt, ...(p.resolution.dismiss ? { dismiss: p.resolution.dismiss } : {}) } : {}),
  };
  return `---\n${stringifyYaml(fm)}---\n\n# 提案 ${p.id}\n\n\`\`\`yaml\n${stringifyYaml(p.ops)}\`\`\`\n`;
}

/** 解析提案 md（round-trip：parseProposal(serializeProposal(p)) 深相等，断言见测试）。 */
export function parseProposal(content: string): Proposal {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error('提案缺 front matter');
  const fm = parseYaml(m[1]!) as Record<string, unknown>;
  const code = content.match(/```yaml\r?\n([\s\S]*?)```/);
  if (!code) throw new Error('提案缺操作序列代码块');
  const ops = parseYaml(code[1]!) as ProposalOp[];
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('提案操作序列为空');
  const resolution =
    fm.decidedAt
      ? { decidedAt: String(fm.decidedAt), ...(fm.dismiss ? { dismiss: fm.dismiss as ProposalDismiss } : {}) }
      : undefined;
  return {
    id: String(fm.id ?? ''),
    origin: (fm.origin as ProposalOrigin) ?? 'scan',
    createdAt: String(fm.createdAt ?? ''),
    ops,
    status: (fm.status as ProposalStatus) ?? 'pending',
    ...(resolution ? { resolution } : {}),
  };
}
