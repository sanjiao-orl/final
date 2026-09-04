/**
 * inbox.svelte.ts —— 统一裁决收件箱壳侧状态（4.2 薄切片批）：列表/勾选/批量裁决/触发扫描。
 * 数据经 core /v1/tools/inbox_list、/v1/tools/inbox_decide、/v1/scan/promise；裁决纪律
 * （驳回必带理由、有意延后带卷锚）与收件箱 md 存储在 domain，壳只搬运。
 */
import type { CoreClient } from './core.js';
import { work } from './work.svelte.js';

export interface InboxOpVM {
  action: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
  targetKey: string;
  rationale: string;
}

export interface InboxEntryVM {
  id: string;
  origin: string;
  status: 'pending' | 'adopted' | 'discarded';
  createdAt: string;
  ops: InboxOpVM[];
  resolution: { decidedAt: string; dismiss?: { reason: string; note?: string; reanchorVolume?: string } } | null;
  verify: { ok: boolean; message: string } | null;
}

export const DISMISS_REASONS = ['误报', '有意延后', '已知情报', '其他'] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

export class InboxStore {
  entries = $state<InboxEntryVM[]>([]);
  /** 勾选的提案 id（仅 pending 可勾）。 */
  selected = $state<Set<string>>(new Set());
  /** 左栏「收件箱」tab 是否打开（与 目录/暂存 互斥）。 */
  tabOpen = $state(false);
  busy = $state(false);
  scanning = $state(false);
  /** 最近一次扫描的覆盖读数（护栏：扫描不在写作热路径的提示面）。 */
  lastScan = $state<{ suspectChapters: number; llmCalls: number; added: number; skipped: number } | null>(null);
  pendingCount = $derived(this.entries.filter((e) => e.status === 'pending').length);
  selectedCount = $derived(this.selected.size);

  private client!: CoreClient;

  init(client: CoreClient): void {
    this.client = client;
  }

  openTab(): void {
    this.tabOpen = true;
    if (this.entries.length === 0) void this.load();
  }

  async load(): Promise<void> {
    if (!this.client || !work.workDir) return;
    this.busy = true;
    try {
      const r = await this.client.callTool<{ count: number; entries: InboxEntryVM[] }>('inbox_list', { workDir: work.workDir });
      this.entries = r.entries;
      // 只保留仍在 pending 的勾选
      const pending = new Set(this.entries.filter((e) => e.status === 'pending').map((e) => e.id));
      this.selected = new Set([...this.selected].filter((id) => pending.has(id)));
    } finally {
      this.busy = false;
    }
  }

  toggle(id: string): void {
    const next = new Set(this.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selected = next;
  }

  selectAllPending(): void {
    const pending = this.entries.filter((e) => e.status === 'pending');
    const all = pending.every((e) => this.selected.has(e.id));
    this.selected = all ? new Set() : new Set(pending.map((e) => e.id));
  }

  /** 批量裁决（勾选项）：逐条调 inbox_decide，单条失败不中断（结果逐条回读）。 */
  async decide(decision: 'adopt' | 'discard', dismissReason?: DismissReason, reanchorVolume?: string): Promise<void> {
    if (this.selected.size === 0 || this.busy) return;
    if (decision === 'discard' && !dismissReason) throw new Error('驳回必带理由');
    this.busy = true;
    try {
      for (const id of this.selected) {
        const body: Record<string, unknown> = { workDir: work.workDir, proposalId: id, decision };
        if (decision === 'discard') {
          body.dismissReason = dismissReason;
          if (reanchorVolume?.trim()) body.reanchorVolume = reanchorVolume.trim();
        }
        await this.client.callTool('inbox_decide', body);
      }
      this.selected = new Set();
      await this.load();
    } finally {
      this.busy = false;
    }
  }

  /** 触发承诺·伏笔补账扫描（便宜档 LLM，非写作热路径；产物直接进收件箱）。 */
  async scan(maxChapters?: number): Promise<void> {
    if (this.scanning || !this.client) return;
    this.scanning = true;
    try {
      const r = await this.client.scanPromise(work.workDir, maxChapters);
      this.lastScan = { suspectChapters: r.suspectChapters, llmCalls: r.llmCalls, added: r.inbox.added.length, skipped: r.inbox.skipped.length };
      await this.load();
    } finally {
      this.scanning = false;
    }
  }
}

export const inbox = new InboxStore();
