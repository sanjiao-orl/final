/**
 * candidates.svelte.ts —— 暂存区（AI 产出的候选项）：流式创建、批量采纳/整改/丢弃。
 * 持久化在 core（sessions.sqlite candidates 表），壳只搬运；采纳落地走编辑器替换 + write_chapter（带快照）。
 */
import type { CoreClient } from './core.js';
import type { Candidate } from './types.js';
import { snapshot } from './snapshot.svelte.js';
import { scheme } from './scheme.svelte.js';
import { work } from './work.svelte.js';
import { ISSUE_LOG_DEFAULT } from './paths.js';

export const CONTINUE_CONTEXT_CHARS = 3000;

/** 暂存候选的壳侧展示扩展（不持久化，core sqlite 只有 Candidate 本体）：声口偏离提示（块2·④ 仪表，生成时刻快照，刷新列表即失）。 */
export type StagedCandidate = Candidate & { voiceNote?: string[] };

/** ledger_diagnostics 返回的机械诊断结果（契约镜像，只消费 findings 计数）。 */
interface LedgerDiagnosticsNotice {
  findings?: Array<{ severity: string; code?: string; message?: string; category?: string }>;
  hasBlockers?: boolean;
  blockerCount?: number;
}

/** ledger_reconcile 返回的对账结果（契约镜像，只消费 anchors 异常计数；lineDrift 提示级不计入提醒）。 */
interface LedgerReconcileNotice {
  anchors?: { checked: number; ok: number; chapterMissing: number; quoteMissing: number; lineDrift: number };
  findings?: Array<{ code?: string; severity?: string; category?: string; message?: string }>;
  skipped?: string;
}

export class CandidatesStore {
  /** 待处理候选（status=pending，按更新时间倒序）。 */
  items = $state<StagedCandidate[]>([]);
  /** 抽屉里勾选的候选 id。 */
  selected = $state<Set<string>>(new Set());
  /** 左栏暂存 tab 是否打开。 */
  stagingTab = $state(false);
  /** 正文区当前查看的候选详情。 */
  viewingId = $state<string | null>(null);
  busy = $state(false);
  /** 流式改写中的生成现场（缺陷修复：改写过程在暂存区实时流式显示，完成态才落候选卡）。 */
  generating = $state<{ chapter: string; original: string; instruction: string; text: string } | null>(null);
  /** 触发式续写在飞状态：过程文本不进编辑器，只显示按钮忙碌态。 */
  continuing = $state(false);
  /** 全览视图（弹出展示全部候选：列表/双栏对照/批量操作/快照还原）。 */
  overviewOpen = $state(false);
  /** 全览视图数据源：全部状态的候选（status 不限，新在前）。 */
  allItems = $state<StagedCandidate[]>([]);
  /** 装饰插件刷新信号：items 任何变化递增（Editor 监听它重建删除线装饰）。 */
  revision = $state(0);
  pendingCount = $derived(this.items.length);
  selectedCount = $derived(this.selected.size);

  private client!: CoreClient;

  init(client: CoreClient): void {
    this.client = client;
  }

  private setItems(list: StagedCandidate[]): void {
    this.items = list;
    this.revision++;
  }

  /** 内联装饰用：某章里可锚定替换的候选（append/replace_all 无锚点，不打删除线；original=='' 会全匹配，滤掉）。 */
  anchoredIn(chapter: string): Candidate[] {
    return this.items.filter((i) => i.chapter === chapter && i.kind === 'replace' && i.original !== '');
  }

  async load(): Promise<void> {
    try {
      const r = await this.client.listCandidates({ status: 'pending' });
      this.setItems(r.candidates);
      if (this.stagingTab && this.viewingId === null) this.viewingId = this.items[0]?.id ?? null;
    } catch (err) {
      work.error = `暂存区加载失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  openStaging(): void {
    this.overviewOpen = false; // 左栏暂存与全览互斥
    this.stagingTab = true;
    const first = this.items[0];
    this.viewingId = first?.id ?? null;
    void this.load();
  }

  /** 全览：载入全部状态候选并弹出（与暂存 tab 互斥）。 */
  async openOverview(): Promise<void> {
    this.stagingTab = false;
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
  /** 触发式续写的 AbortController（续写按钮旁的取消入口）。 */
  private continueAbort: AbortController | null = null;
  /** 批量整改的 AbortController（全览头部的取消入口）。 */
  private rectifyAbort: AbortController | null = null;
  /** 批量整改在飞状态（取消按钮显隐）。 */
  rectifying = $state(false);
  /** 流式生成期间是否在生成中（用于按钮态）。 */
  isGenerating = $derived(this.generating !== null);

  /** 触发式续写：当前正文末尾 3000 字符 → SSE → append 候选，只在暂存区生效。 */
  async continueFromChapter(): Promise<boolean> {
    if (this.continuing || !work.current) return false;
    const chapter = work.current;
    const context = (work.editorApiText?.() ?? chapter.savedMd).slice(-CONTINUE_CONTEXT_CHARS);
    if (!context.trim()) return false;
    this.continuing = true;
    const ac = new AbortController();
    this.continueAbort = ac;
    let text = '';
    const failure: { err: Error | null } = { err: null };
    const voice: { note: string[] | null } = { note: null };
    try {
      await this.client.continueText(
        { context, instruction: '续写', ...(work.workDir ? { workDir: work.workDir } : {}) },
        {
          onText: (d) => { text += d; },
          onDone: ({ text: done, voice: v }) => { text = done; voice.note = v?.flags?.length ? v.flags : null; },
          onError: (err) => { failure.err = err; },
        },
        ac.signal,
      );
      if (ac.signal.aborted) return false; // 已取消：迟到完成也不落候选、不报错
      if (failure.err) throw failure.err;
      if (!text.trim()) return false;
      const r = await this.client.createCandidate({ chapter: chapter.relPath, original: '', proposed: text, instruction: '续写', kind: 'append' });
      this.setItems([{ ...r.candidate, ...(voice.note ? { voiceNote: voice.note } : {}) }, ...this.items]);
      return true;
    } catch (err) {
      if (!ac.signal.aborted) work.error = `AI 续写失败：${err instanceof Error ? err.message : String(err)}`;
      return false;
    } finally {
      // 取消/失败都释放 continuing，不再永久锁死
      this.continueAbort = null;
      this.continuing = false;
    }
  }

  /** 取消触发式续写（Editor 续写按钮旁的停止入口）。 */
  abortContinue(): void {
    this.continueAbort?.abort();
  }

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
    const voice: { note: string[] | null } = { note: null };
    this.generating = { chapter, original, instruction: instruction.trim(), text: '' };
    this.stagingTab = true; // 左栏实时展示生成状态
    const ac = new AbortController();
    this.generateAbort = ac;
    try {
      // 决策 0010：激活方案映射到 rewrite 通道的 persona（改写/整改共用）。
      const persona = scheme.channelPersona('rewrite');
      await this.client.rewriteStream(
        { original, instruction, ...(work.workDir ? { workDir: work.workDir } : {}), ...(persona ? { persona } : {}) },
        {
          onDelta: (d) => {
            text += d;
            if (this.generating) this.generating = { ...this.generating, text };
            onProgress?.(text);
          },
          onDone: ({ text: t, voice: v }) => {
            text = t;
            voice.note = v?.flags?.length ? v.flags : null;
          },
          onError: (err) => {
            failure.err = err;
          },
        },
        ac.signal,
      );
      if (failure.err) throw failure.err;
      this.generating = null;
      if (ac.signal.aborted) return false; // 已取消：迟到完成也不落候选、不报错
      const r = await this.client.createCandidate({ chapter, original, proposed: text, instruction });
      this.setItems([{ ...r.candidate, ...(voice.note ? { voiceNote: voice.note } : {}) }, ...this.items]);
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
    workDir?: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    let text = '';
    const failure: { err: Error | null } = { err: null }; // 闭包赋值，TS 收窄不跨闭包，用对象持有
    try {
      const persona = scheme.channelPersona('rewrite');
      await this.client.rewriteStream(
        { original, instruction, ...(workDir ? { workDir } : {}), ...(persona ? { persona } : {}) },
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
      let adoptedAny = false;
      let patchFailures = 0;
      let firstPatchErrMsg: string | null = null;
      /** 实际采纳了候选的章 relPath 集合（章摘要生成触发范围）。 */
      const affectedChapters = new Set<string>();
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
          if (c.kind === 'append') {
            const r = work.appendMd(c.proposed);
            if (r === 'ok') {
              applied.push(c.id);
            } else {
              failures.push('追加失败：编辑器未就绪');
            }
          } else if (c.kind === 'replace_all') {
            const r = work.replaceBodyMd(c.proposed);
            if (r === 'ok') {
              applied.push(c.id);
            } else {
              failures.push('整章替换失败：编辑器未就绪');
            }
          } else {
            const r = work.applyEdit(c.original, c.proposed);
            if (r === 'ok') {
              applied.push(c.id);
            } else {
              failures.push(
                `${c.original.slice(0, 24)}…（${r === 'ambiguous' ? '原文在本章多处出现，无法定位' : '原文已变动，找不到锚点'}）`,
              );
            }
          }
        }
        if (applied.length === 0) continue;
        adoptedAny = true;
        affectedChapters.add(chapter);

        // 采纳是作者决策：替换成功即落状态；保存失败另有红条+脏标记兜底
        // 逐条落库：单条 patch 失败收集计数继续，不中断其余已应用候选（成功的照常 adopted，不整批回滚）
        for (const id of applied) {
          try {
            await this.client.patchCandidate(id, { status: 'adopted' });
          } catch (err) {
            patchFailures++;
            if (!firstPatchErrMsg) firstPatchErrMsg = err instanceof Error ? err.message : String(err);
          }
        }
        await work.saveCurrent(); // 失败红条在 work.error，状态已按决策落库
      }

      // 汇总失败（锚点/编辑器未就绪 + 落库失败）：部分失败才报红条，全成则不打扰
      const errs: string[] = [...failures];
      if (patchFailures > 0) {
        errs.push(`落库失败 ${patchFailures} 条${firstPatchErrMsg ? `：${firstPatchErrMsg}` : ''}`);
      }
      if (errs.length > 0) {
        work.error = `部分候选未能采纳：${errs.join('；')}`;
      }
      // 批三-3：采纳落定（PATCH 完成、保存触发）后机械层自动跑账本诊断 + 对账，有发现弹一次合并轻提示，
      // 无发现/失败静默。单一收口点在这里：StagingDrawer / StagingOverview / Editor 内联 ✓ 三个入口全部走 adopt()。
      if (adoptedAny) {
        // 章摘要（导生缓存）逐章重建：fire-and-forget，失败静默——摘要只是加速读取的缓存，下次采纳会重建
        for (const relPath of affectedChapters) {
          void this.client.generateSummary(work.workDir, relPath).catch(() => {});
        }
        void this.notifyDiagnosticsAfterAdopt(affectedChapters);
      }
    } catch (err) {
      work.error = `采纳失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      // 总是重拉列表（部分失败也要刷新，避免抽屉仍把已 adopted 的显示为 pending）+ 清选择 + 复位 busy
      await this.load();
      if (this.overviewOpen) void this.loadAll();
      if (this.viewingId && !this.items.some((i) => i.id === this.viewingId)) {
        this.viewingId = this.items[0]?.id ?? null;
      }
      this.clearSelection();
      this.busy = false;
    }
  }

  /**
   * 采纳落定后的自动账本体检（fire-and-forget，不阻塞采纳主链路）：ledger_diagnostics 机械诊断 +
   * ledger_reconcile 锚点对账并行跑，两者都完成后合并计数弹一次轻提示；任一失败不影响另一个，
   * 双双无异常 / 失败 → 不打扰（全静默）。对账计数口径用 chapterMissing+quoteMissing（lineDrift 提示级不计）。
   * T12：有发现时附「让 AI 同步账本」引导按钮，prefillChat 预填含涉及章节清单的结构化同步指令（不自动发送）。
   */
  private async notifyDiagnosticsAfterAdopt(affectedChapters: Set<string>): Promise<void> {
    if (!this.client || !work.workDir) return;
    const diagP = this.client
      .callTool<LedgerDiagnosticsNotice>('ledger_diagnostics', {
        workDir: work.workDir,
        issueLogPath: ISSUE_LOG_DEFAULT,
      })
      .catch(() => null); // 单边失败静默降级为 null，不让它拖垮另一边的结果
    const reconcileP = this.client
      .callTool<LedgerReconcileNotice>('ledger_reconcile', { workDir: work.workDir })
      .catch(() => null);
    const [diag, rec] = await Promise.all([diagP, reconcileP]);
    const findings = diag?.findings ?? [];
    const anchorIssues = (rec?.anchors?.chapterMissing ?? 0) + (rec?.anchors?.quoteMissing ?? 0);
    if (findings.length === 0 && anchorIssues === 0) return;
    const parts: string[] = [];
    if (findings.length > 0) parts.push(`诊断 ${findings.length} 条`);
    if (anchorIssues > 0) parts.push(`对账 ${anchorIssues} 处锚异常`);
    snapshot.showNotice(`${parts.join(' · ')} · 审阅面板查看`, {
      label: '让 AI 同步账本',
      prefillChat:
        `我刚采纳了一批正文候选（章节：${[...affectedChapters].join('、')}）。` +
        '请对照本次采纳内容检查剧情事实变动（新埋伏笔/道具易手/角色知情变化/时间推进）：' +
        '先列出你打算用 ledger_upsert 写入或更新的条目清单给我确认，我确认后你再写账本；没有变动就回复「无需同步」。',
    });
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

  /** 整改公共实现：逐条流式重写（目标卡 proposed 逐批更新），指令留痕。
   *  缺陷修复：接 AbortSignal + 取消入口；单条失败逐条可见、不阻塞其余条目（原先整批抛出 → 全站禁用）。 */
  private async rectifyTargets(targets: Candidate[], ask: string): Promise<void> {
    if (targets.length === 0 || this.busy) return;
    this.busy = true;
    this.rectifying = true;
    const ac = new AbortController();
    this.rectifyAbort = ac;
    try {
      const persona = scheme.channelPersona('rewrite');
      const failures: string[] = [];
      for (const [n, c] of targets.entries()) {
        if (ac.signal.aborted) break; // 取消：剩余条目不再发起，已完成条目保留
        let text = '';
        const failure: { err: Error | null } = { err: null };
        const voice: { note: string[] | null } = { note: null };
        try {
          await this.client.rewriteStream(
            { original: c.original, instruction: `上一版改写：\n${c.proposed}\n\n整改要求：${ask}`, ...(work.workDir ? { workDir: work.workDir } : {}), ...(persona ? { persona } : {}) },
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
              onDone: ({ text: t, voice: v }) => {
                text = t;
                voice.note = v?.flags?.length ? v.flags : null;
              },
              onError: (err) => {
                failure.err = err;
              },
            },
            ac.signal,
          );
          if (ac.signal.aborted) break; // 取消发生在本条流式期间：迟到完成不落库
          if (failure.err) throw failure.err;
          await this.client.patchCandidate(c.id, {
            proposed: text,
            instruction: `${c.instruction || '润色'} / 整改：${ask}`,
          });
          // 本地即时更新（流式期间装饰已随旧 proposed 显示，整改后刷新）
          this.setItems(this.items.map((i) => (i.id === c.id ? { ...i, proposed: text, instruction: `${c.instruction || '润色'} / 整改：${ask}`, ...(voice.note ? { voiceNote: voice.note } : {}) } : i)));
        } catch (err) {
          // 单条失败收集进汇总红条，继续处理其余条目
          failures.push(`第 ${n + 1} 条整改失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // 汇总失败（逐条可见）：全部成功则不打扰
      if (failures.length > 0) {
        work.error = failures.join('；');
      }
      if (this.overviewOpen) void this.loadAll();
    } finally {
      // 取消/失败都复位 busy + rectifying，采纳/丢弃不再全站禁用
      this.rectifyAbort = null;
      this.rectifying = false;
      this.busy = false;
    }
  }

  /** 取消批量整改（全览头部的停止入口）：中止剩余条目，已完成条目保留。 */
  abortRectify(): void {
    this.rectifyAbort?.abort();
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
