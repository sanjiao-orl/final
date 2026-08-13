/**
 * approval.ts —— B6 分级审批状态机（壳私有，core 不为此加逻辑）。
 * 危险工具集：AI 直调 write_chapter / delete_chapter / export_txt（暂存采纳路径不弹，已有人的裁决）。
 *
 * 约束说明：core 的 /v1/chat 在事件流内自行执行工具（tool-call 与 tool-result 之间），
 * 壳无法在"执行前"拦截——因此审批是"放行语义 + 拒绝补偿"：拒绝 write_chapter 时
 * 用 .novel/history/ 的事前快照还原（core 每次覆写前自动快照，B4 安全阀），
 * 拒绝 delete_chapter 时从 .novel/trash/ 还原，拒绝 export_txt 时提示保留路径。
 *
 * 模式语义：ask=逐项询问；auto=本会话内同工具同目标放行一次后不再询问；yolo=全部自动放行
 * （写入仍强制事前快照，不受模式影响）。
 */
/** AI 直调即视为危险、需审批的工具。 */
export const DANGEROUS_TOOLS = new Set(['write_chapter', 'delete_chapter', 'export_txt']);

export type ApprovalDecision = 'allow' | 'pending';
export type ApprovalVerdict = 'once' | 'session' | 'reject';

export interface ApprovalRequest {
  /** 工具调用 id（与 SSE tool-call 的 id 配对）。 */
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /** 影响范围的人类可读描述（如目标章 relPath）。 */
  target: string;
  /** 会话级放行的去重键（工具名 + 目标）。 */
  targetKey: string;
}

/** 工具 → 影响范围描述与放行去重键。 */
export function describeDangerous(name: string, args: Record<string, unknown>): { target: string; targetKey: string } {
  const rel = typeof args.relPath === 'string' ? args.relPath : '';
  switch (name) {
    case 'write_chapter':
      return { target: rel || '（未指定章）', targetKey: `write:${rel}` };
    case 'delete_chapter':
      return { target: rel || '（未指定章）', targetKey: `delete:${rel}` };
    default:
      return { target: '全稿导出 txt', targetKey: 'export' };
  }
}

export class ApprovalGate {
  /** 挂起待审批的调用（按出现顺序）。 */
  pending = $state<ApprovalRequest[]>([]);
  /** 当前展示的审批卡（一次一张，最旧优先）。 */
  active = $state<ApprovalRequest | null>(null);
  /** 本会话内已放行的 (name:targetKey)。 */
  private sessionAllowed = new Map<string, Set<string>>();

  /** 工具调用进入审批门：返回 'allow' 直接放行，'pending' 挂起等用户裁决。callId 为 SSE tool-call 的 id。 */
  decide(callId: string, name: string, args: Record<string, unknown>, mode: 'ask' | 'auto' | 'yolo'): ApprovalDecision {
    if (!DANGEROUS_TOOLS.has(name)) return 'allow';
    if (mode === 'yolo') return 'allow';
    const { target, targetKey } = describeDangerous(name, args);
    if (mode === 'auto' && this.sessionAllowed.get(name)?.has(targetKey)) return 'allow';
    // 同名同目标在流内只挂一条（多轮工具调用不重复弹卡）
    let req = this.pending.find((p) => p.name === name && p.targetKey === targetKey);
    if (!req) {
      req = { callId, name, args, target, targetKey };
      this.pending = [...this.pending, req];
    }
    if (!this.active) this.active = req;
    return 'pending';
  }

  /** 用户裁决：once=仅本次放行；session=本会话同类放行；reject=拒绝（调用方做补偿还原）。 */
  resolve(callId: string, verdict: ApprovalVerdict): void {
    const req = this.pending.find((p) => p.callId === callId) ?? this.pending[0];
    if (!req) return;
    if (verdict === 'session') {
      const set = this.sessionAllowed.get(req.name) ?? new Set();
      set.add(req.targetKey);
      this.sessionAllowed.set(req.name, set);
    }
    this.pending = this.pending.filter((p) => p !== req);
    this.active = this.pending[0] ?? null;
  }

  /** 由工具名+目标键把挂起卡直接移除（拒绝后的补偿路径）。 */
  removeByTarget(name: string, targetKey: string): void {
    this.pending = this.pending.filter((p) => !(p.name === name && p.targetKey === targetKey));
    this.active = this.pending[0] ?? null;
  }

  isPending(name: string, targetKey: string): boolean {
    return this.pending.some((p) => p.name === name && p.targetKey === targetKey);
  }

  /** 切换/新建会话时清掉本会话放行表：文案承诺"本会话不再询问"以会话为单位。 */
  resetSessionAllowed(): void {
    this.sessionAllowed.clear();
  }
}

export const approval = new ApprovalGate();
