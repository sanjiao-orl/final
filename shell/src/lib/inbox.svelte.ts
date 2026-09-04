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

/** 扫描长任务超时：逐章串行 LLM 判定远超缺省 30s，对齐 review 的 600s 长任务口径（4.2.1 修复前吃缺省必超时静默失败）。 */
const SCAN_CALL_TIMEOUT_MS = 600_000;

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
    void this.load(); // 每次打开都刷新：重启/换书后不留上一本书残留，徽章口径随 boot load 兜底
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
    } catch (err) {
      // 失败可见：不再伪装成「收件箱为空」（4.2.1）
      work.error = `收件箱加载失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.busy = false;
    }
  }

  toggle(id: string): void {
    if (this.busy) return; // 批量裁决进行中冻结勾选（中途操作与在飞批次脱节）
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

  /** 批量裁决（勾选项）：逐条调 inbox_decide，单条失败不中断批次——失败的保留勾选可重试并报错（4.2.1 兑现注释语义）。 */
  async decide(decision: 'adopt' | 'discard', dismissReason?: DismissReason, reanchorVolume?: string): Promise<void> {
    if (this.selected.size === 0 || this.busy) return;
    if (decision === 'discard' && !dismissReason) throw new Error('驳回必带理由');
    this.busy = true;
    const failed: string[] = [];
    try {
      for (const id of this.selected) {
        const body: Record<string, unknown> = { workDir: work.workDir, proposalId: id, decision };
        if (decision === 'discard') {
          body.dismissReason = dismissReason;
          if (reanchorVolume?.trim()) body.reanchorVolume = reanchorVolume.trim();
        }
        try {
          await this.client.callTool('inbox_decide', body);
        } catch (err) {
          failed.push(id);
          work.error = `批量裁决失败（该条已保留勾选）：${err instanceof Error ? err.message : String(err)}`;
        }
      }
      this.selected = new Set(failed);
      await this.load();
    } finally {
      this.busy = false;
    }
  }

  /** 触发承诺·伏笔补账扫描（便宜档 LLM，非写作热路径；产物直接进收件箱）。失败可见不静默（4.2.1）。 */
  async scan(maxChapters?: number): Promise<void> {
    if (this.scanning || !this.client) return;
    this.scanning = true;
    try {
      const r = await this.client.scanPromise(work.workDir, maxChapters, { timeoutMs: SCAN_CALL_TIMEOUT_MS });
      this.lastScan = { suspectChapters: r.suspectChapters, llmCalls: r.llmCalls, added: r.inbox.added.length, skipped: r.inbox.skipped.length };
      await this.load();
    } catch (err) {
      work.error = `补账扫描失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.scanning = false;
    }
  }
}

export const inbox = new InboxStore();
