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
  /** 流式改写中的生成现场（缺陷修复：改写过程在暂存区实时流式显示，完成态才落候选卡）。 */
  generating = $state<{ chapter: string; original: string; instruction: string; text: string } | null>(null);
  /** 全览视图（弹出展示全部候选：列表/双栏对照/批量操作/快照还原）。 */
  overviewOpen = $state(false);
  /** 全览视图数据源：全部状态的候选（status 不限，新在前）。 */
  allItems = $state<Candidate[]>([]);
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
    if (this.drawerOpen) {
      this.drawerOpen = false;
      return;
    }
    this.overviewOpen = false; // 抽屉与全览互斥
    this.drawerOpen = true;
    void this.load();
  }

  /** 全览：载入全部状态候选并弹出（与抽屉互斥）；关闭时清空选中。 */
  async openOverview(): Promise<void> {
    this.drawerOpen = false;
    this.overviewOpen = true;
    await this.loadAll();
  }

  closeOverview(): void {
    this.overviewOpen = false;
    this.clearSelection();
  }

  /** 全部状态候选（status 不限，新在前）——全览视图数据源。 */
  async loadAll(): Promise<void> {
    try {
      const r = await this.client.listCandidates();
      this.allItems = r.candidates;
    } catch (err) {
      work.error = `暂存全览加载失败：${err instanceof Error ? err.message : String(err)}`;
    }
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

  /** 流式生成的 AbortController（取消按钮接这里）。 */
  private generateAbort: AbortController | null = null;
  /** 流式生成期间是否在生成中（用于按钮态）。 */
  isGenerating = $derived(this.generating !== null);

  /** 取消当前流式生成（接在 selectionPopover/暂存区入口的停止按钮）。 */
  abortGenerate(): void {
    this.generateAbort?.abort();
  }

  /**
   * 选区改写：/rewrite 流式生成 → 完成后 POST /candidates 进暂存区。
   * 生成过程实时进 generating（暂存区流式显示，30–50ms 批次），完成态落候选卡。
   * 失败显式报错返回 false。
   */
  async createFromSelection(
    chapter: string,
    original: string,
    instruction: string,
    onProgress?: (text: string) => void,
  ): Promise<boolean> {
    let text = '';
    const failure: { err: Error | null } = { err: null }; // 闭包赋值，TS 收窄不跨闭包，用对象持有
    this.generating = { chapter, original, instruction: instruction.trim(), text: '' };
    this.drawerOpen = true; // 暂存区实时展示生成内容
    const ac = new AbortController();
    this.generateAbort = ac;
    try {
      await this.client.rewriteStream(
        { original, instruction },
        {
          onDelta: (d) => {
            text += d;
            if (this.generating) this.generating = { ...this.generating, text };
            onProgress?.(text);
          },
          onDone: ({ text: t }) => {
            text = t;
          },
          onError: (err) => {
            failure.err = err;
          },
        },
        ac.signal,
      );
      if (failure.err) throw failure.err;
      this.generating = null;
      const r = await this.client.createCandidate({ chapter, original, proposed: text, instruction });
      this.setItems([r.candidate, ...this.items]);
      return true;
    } catch (err) {
      this.generating = null;
      if (!ac.signal.aborted) {
        work.error = `AI 改写失败：${err instanceof Error ? err.message : String(err)}`;
      }
      return false;
    } finally {
      this.generateAbort = null;
    }
  }

  /** B1 就地浮层用：/rewrite 流式改写，只回文本不落暂存区；失败报错返回 null。 */
  async rewriteText(
    original: string,
    instruction: string,
    onProgress?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<string | null> {
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
        signal,
      );
      if (failure.err) throw failure.err;
      return text;
    } catch (err) {
      if (!signal?.aborted) {
        work.error = `AI 改写失败：${err instanceof Error ? err.message : String(err)}`;
      }
      return null;
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
      if (this.overviewOpen) void this.loadAll();
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
    if (targets.length === 0 || !ask) return;
    await this.rectifyTargets(targets, ask);
    this.clearSelection();
  }

  /** 单条整改（全览视图）：按新要求重写单条候选。 */
  async rectifyOne(c: Candidate, rectifyText: string): Promise<void> {
    const ask = rectifyText.trim();
    if (!ask) return;
    await this.rectifyTargets([c], ask);
  }

  /** 整改公共实现：逐条流式重写（目标卡 proposed 逐批更新），指令留痕。 */
  private async rectifyTargets(targets: Candidate[], ask: string): Promise<void> {
    if (targets.length === 0 || this.busy) return;
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
              const next = { ...c, proposed: text };
              // 流式整改：目标卡的 proposed 逐批更新（30–50ms 批次进 store）
              this.setItems(this.items.map((i) => (i.id === c.id ? next : i)));
              // 全览打开时（整改可能由全览发起）同步 allItems，全览内同样实时可见
              if (this.overviewOpen) {
                this.allItems = this.allItems.map((i) => (i.id === c.id ? next : i));
              }
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
      if (this.overviewOpen) void this.loadAll();
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
      if (this.overviewOpen) void this.loadAll();
      this.clearSelection();
    } catch (err) {
      work.error = `丢弃失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.busy = false;
    }
  }
}

export const candidates = new CandidatesStore();
