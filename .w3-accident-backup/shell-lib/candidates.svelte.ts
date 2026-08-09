/**
 * candidates.svelte.ts —— 暂存区（AI 产出的候选项）：流式创建、批量采纳/整改/丢弃。
 * 持久化在 core（sessions.sqlite candidates 表），壳只搬运；采纳落地走编辑器替换 + write_chapter（带快照）。
 */
import type { CoreClient } from './core.js';
import type { Candidate } from './types.js';
import { work } from './work.svelte.js';

export class CandidatesStore {
  /** 待处理候选（status=pending，按更新时间倒序）。 */
  items = $state<Candidate[]>([]);
  /** 抽屉里勾选的候选 id。 */
  selected = $state<Set<string>>(new Set());
  drawerOpen = $state(false);
  busy = $state(false);
  /** 装饰插件刷新信号：items 任何变化递增（Editor 监听它重建删除线装饰）。 */
  revision = $state(0);
  pendingCount = $derived(this.items.length);
  selectedCount = $derived(this.selected.size);

  private client!: CoreClient;

  init(client: CoreClient): void {
    this.client = client;
  }

  private setItems(list: Candidate[]): void {
    this.items = list;
    this.revision++;
  }

  async load(): Promise<void> {
    try {
      const r = await this.client.listCandidates({ status: 'pending' });
      this.setItems(r.candidates);
    } catch (err) {
      work.error = `暂存区加载失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  toggleDrawer(): void {
    this.drawerOpen = !this.drawerOpen;
    if (this.drawerOpen) void this.load();
  }

  toggleSelect(id: string): void {
    const next = new Set(this.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selected = next;
  }

  toggleSelectAll(): void {
    this.selected = this.selected.size === this.items.length ? new Set() : new Set(this.items.map((i) => i.id));
  }

  clearSelection(): void {
    this.selected = new Set();
  }

  /**
   * 选区改写：/rewrite 流式生成 → 完成后 POST /candidates 进暂存区。
   * onProgress 逐批回调已累计文本（浮动条显示进度）；失败显式报错返回 false。
   */
  async createFromSelection(
    chapter: string,
    original: string,
    instruction: string,
    onProgress?: (text: string) => void,
  ): Promise<boolean> {
    let text = '';
    const failure: { err: Error | null } = { err: null }; // 闭包赋值，TS 收窄不跨闭包，用对象持有
    try {
      await this.client.rewriteStream(
        { original, instruction },
        {
          onDelta: (d) => {
            text += d;
            onProgress?.(text);
          },
          onDone: ({ text: t }) => {
            text = t;
          },
          onError: (err) => {
            failure.err = err;
          },
        },
      );
      if (failure.err) throw failure.err;
      const r = await this.client.createCandidate({ chapter, original, proposed: text, instruction });
      this.setItems([r.candidate, ...this.items]);
      return true;
    } catch (err) {
      work.error = `AI 改写失败：${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  /** 批量采纳：编辑器内按 original 定位替换 → 状态落库 → 保存（快照安全阀）。 */
  async adoptSelected(): Promise<void> {
    await this.adopt(this.items.filter((i) => this.selected.has(i.id)));
  }

  /** 单条采纳（内联装饰上的 ✓）。 */
  async adoptOne(c: Candidate): Promise<void> {
    await this.adopt([c]);
  }

  private async adopt(list: Candidate[]): Promise<void> {
    if (list.length === 0 || this.busy) return;
    this.busy = true;
    try {
      // 按章分组：每组开章（必要时）→ 逐条替换 → 统一保存
      const byChapter = new Map<string, Candidate[]>();
      for (const c of list) {
        const g = byChapter.get(c.chapter) ?? [];
        g.push(c);
        byChapter.set(c.chapter, g);
      }

      const failures: string[] = [];
      for (const [chapter, group] of byChapter) {
        if (work.current?.relPath !== chapter) {
          const node = work.findChapter(chapter);
          if (!node) {
            failures.push(`章节已不在结构树中：${chapter}`);
            continue;
          }
          await work.openChapter(node);
          if (work.error) return; // 开章失败（含未保存冲突），红条已在
        }
        if (!(await work.whenEditorReady())) {
          failures.push(`编辑器未就绪：${chapter}`);
          continue;
        }

        const applied: string[] = [];
        for (const c of group) {
          const r = work.applyEdit(c.original, c.proposed);
          if (r === 'ok') {
            applied.push(c.id);
          } else {
            failures.push(
              `${c.original.slice(0, 24)}…（${r === 'ambiguous' ? '原文在本章多处出现，无法定位' : '原文已变动，找不到锚点'}）`,
            );
          }
        }
        if (applied.length === 0) continue;

        // 采纳是作者决策：替换成功即落状态；保存失败另有红条+脏标记兜底
        for (const id of applied) await this.client.patchCandidate(id, { status: 'adopted' });
        await work.saveCurrent(); // 失败红条在 work.error，状态已按决策落库
      }

      if (failures.length > 0) {
        work.error = `部分候选未能采纳：${failures.join('；')}`;
      }
      await this.load();
      this.clearSelection();
    } catch (err) {
      work.error = `采纳失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.busy = false;
    }
  }

  /** 批量整改：选中候选按整改要求重新改写，proposed 与指令留痕更新，状态保持 pending。 */
  async rectifySelected(rectifyText: string): Promise<void> {
    const targets = this.items.filter((i) => this.selected.has(i.id));
    const ask = rectifyText.trim();
    if (targets.length === 0 || !ask || this.busy) return;
    this.busy = true;
    try {
      for (const [n, c] of targets.entries()) {
        let text = '';
        const failure: { err: Error | null } = { err: null };
        await this.client.rewriteStream(
          { original: c.original, instruction: `上一版改写：\n${c.proposed}\n\n整改要求：${ask}` },
          {
            onDelta: (d) => {
              text += d;
            },
            onDone: ({ text: t }) => {
              text = t;
            },
            onError: (err) => {
              failure.err = err;
            },
          },
        );
        if (failure.err) throw new Error(`第 ${n + 1} 条整改失败：${failure.err.message}`);
        await this.client.patchCandidate(c.id, {
          proposed: text,
          instruction: `${c.instruction || '润色'} / 整改：${ask}`,
        });
        // 本地即时更新（流式期间装饰已随旧 proposed 显示，整改后刷新）
        this.setItems(this.items.map((i) => (i.id === c.id ? { ...i, proposed: text, instruction: `${c.instruction || '润色'} / 整改：${ask}` } : i)));
      }
      this.clearSelection();
    } catch (err) {
      work.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
    }
  }

  /** 批量丢弃：状态落库 discarded，从暂存区移除（记录仍在库中可查）。 */
  async discardSelected(): Promise<void> {
    await this.discard(this.items.filter((i) => this.selected.has(i.id)));
  }

  /** 单条丢弃（内联装饰上的 ×）。 */
  async discardOne(c: Candidate): Promise<void> {
    await this.discard([c]);
  }

  private async discard(list: Candidate[]): Promise<void> {
    if (list.length === 0 || this.busy) return;
    this.busy = true;
    try {
      for (const c of list) await this.client.patchCandidate(c.id, { status: 'discarded' });
      await this.load();
      this.clearSelection();
    } catch (err) {
      work.error = `丢弃失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.busy = false;
    }
  }
}

export const candidates = new CandidatesStore();
