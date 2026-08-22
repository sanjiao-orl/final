<script lang="ts">
  // 暂存全览（缺陷5修复）：弹出全览视图——全部候选列表（状态可筛）、双栏对照、批量采纳/整改/丢弃、
  // 快照还原入口保留。形态类似右侧 AI 面板：固定高度侧栏，栏内滚动。
  import { iconSvg } from '../../lib/icons.js';
  import { candidates } from '../../lib/candidates.svelte.js';
  import { settings } from '../../lib/settings.svelte.js';
  import { snapshot } from '../../lib/snapshot.svelte.js';
  import { dialog } from '../../lib/dialog.svelte.js';
  import { work } from '../../lib/work.svelte.js';
  import type { Candidate } from '../../lib/types.js';

  type Filter = 'all' | 'pending' | 'adopted' | 'discarded';
  let filter = $state<Filter>('all');

  const TABS: { id: Filter; label: string }[] = [
    { id: 'all', label: '全部' },
    { id: 'pending', label: '待处理' },
    { id: 'adopted', label: '已采纳' },
    { id: 'discarded', label: '已丢弃' },
  ];

  const visible = $derived(
    candidates.allItems.filter((c) => filter === 'all' || c.status === filter),
  );

  function chapterLabel(c: { chapter: string }): string {
    const cur = work.current;
    if (c.chapter === cur?.relPath) return cur.title;
    return c.chapter.split(/[\\/]/).pop()?.replace(/\.md$/, '') ?? c.chapter;
  }

  function timeOf(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const STATUS_LABEL: Record<string, string> = { pending: '待处理', adopted: '已采纳', discarded: '已丢弃' };
  const KIND_LABEL: Record<string, string> = { replace: '替换', append: '追加', replace_all: '整章' };

  async function adoptSelected(): Promise<void> {
    const count = candidates.selectedCount;
    if (count === 0) return;
    await candidates.adoptSelected();
    if (count > 0) {
      const first = visible.find((i) => candidates.selected.has(i.id)) ?? visible[0];
      if (first) void snapshot.showAdoptedToast(`已采纳 ${count} 条候选 · ${chapterLabel(first)}`, first.chapter);
    }
  }

  async function rectifySelected(): Promise<void> {
    if (candidates.selectedCount === 0) return;
    const ask = await dialog.prompt({
      message: `整改要求（对选中的 ${candidates.selectedCount} 条候选重新改写）`,
      placeholder: '整改要求…',
    });
    if (ask === null || ask.trim() === '') return;
    await candidates.rectifySelected(ask);
  }

  async function rectifyOne(c: Candidate): Promise<void> {
    const ask = await dialog.prompt({
      message: `整改要求（对「${chapterLabel(c)}」这条候选重新改写）`,
      placeholder: '整改要求…',
    });
    if (ask === null || ask.trim() === '') return;
    await candidates.rectifyOne(c, ask);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') candidates.closeOverview();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overview" role="dialog" aria-modal="true" aria-label="暂存全览">
  <div class="head">
    <span class="title">暂存全览{#if candidates.allItems.length > 0}<i class="n">{candidates.allItems.length}</i>{/if}</span>
    <div class="tabs">
      {#each TABS as t (t.id)}
        <button class="tab" class:on={filter === t.id} onclick={() => (filter = t.id)}>{t.label}</button>
      {/each}
    </div>
    <span class="snap" title="B4：采纳前自动快照；顶栏「快照」可还原当前章">
      {@html iconSvg('snapshot', 12)}
      采纳前自动快照 · 顶栏「快照」一键还原
    </span>
    <div class="actions">
      {#if candidates.busy}<span class="busy">处理中…</span>{/if}
      {#if candidates.rectifying}<button class="btn sm" onclick={() => candidates.abortRectify()} title="中止批量整改：剩余条目不再发起，已完成条目保留">取消整改</button>{/if}
      <label class="chk">
        <input
          type="checkbox"
          checked={visible.length > 0 && visible.every((c) => candidates.selected.has(c.id))}
          onchange={() => {
            const pendingIds = visible.filter((c) => c.status === 'pending').map((c) => c.id);
            const allOn = pendingIds.length > 0 && pendingIds.every((id) => candidates.selected.has(id));
            if (allOn) {
              const next = new Set(candidates.selected);
              for (const id of pendingIds) next.delete(id);
              candidates.selected = next;
            } else {
              candidates.selected = new Set([...candidates.selected, ...pendingIds]);
            }
          }}
        />
        全选
      </label>
      <button class="btn sm primary" disabled={candidates.selectedCount === 0 || candidates.busy} onclick={() => void adoptSelected()} title="选中候选替换进正文并保存（带历史快照）">采纳</button>
      <button class="btn sm" disabled={candidates.selectedCount === 0 || candidates.busy} onclick={() => void rectifySelected()} title="按新要求重新改写选中候选">整改</button>
      <button class="btn sm ghost-danger" disabled={candidates.selectedCount === 0 || candidates.busy} onclick={() => void candidates.discardSelected()} title="丢弃选中候选（记录仍在库中）">丢弃</button>
      <button class="icon-btn" onclick={() => candidates.closeOverview()} aria-label="关闭全览">{@html iconSvg('close', 14, 2)}</button>
    </div>
  </div>

  <div class="body">
    {#if visible.length === 0}
      <div class="empty">没有{candidates.allItems.length === 0 ? '' : '该状态的'}候选。选中正文里的文字发起 AI 改写，产出会先进暂存区。</div>
    {/if}
    {#each visible as c (c.id)}
      <div class="card" class:decided={c.status !== 'pending'}>
        <div class="meta">
          {#if c.status === 'pending'}
            <input type="checkbox" checked={candidates.selected.has(c.id)} onchange={() => candidates.toggleSelect(c.id)} aria-label="选择候选" />
          {:else}
            <span class="nochk"></span>
          {/if}
          <span class="status-pill {c.status}">{STATUS_LABEL[c.status] ?? c.status}</span>
          <span class="ch">{chapterLabel(c)}</span>
          {#if c.kind}<span class="kind-pill" class:append={c.kind === 'append'} class:replace_all={c.kind === 'replace_all'}>{KIND_LABEL[c.kind] ?? c.kind}</span>{/if}
          {#if settings.showInstruction}
            <span class="instr">为何采纳(B8)：<b>{c.instruction || '润色'}</b></span>
          {/if}
          <span class="time">{timeOf(c.createdAt)} · 会话「{c.sessionId ? c.sessionId.slice(0, 8) : '直接改写'}」</span>
        </div>
        <div class="diff">
          <div class="col">
            <div class="lbl">原 文</div>
            <div class="old">{c.original || '（新增段：此处原本没有内容）'}</div>
          </div>
          <svg class="arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          <div class="col">
            <div class="lbl">候 选</div>
            <div class="new">{c.proposed}</div>
          </div>
          <div class="ops">
            {#if c.status === 'pending'}
              <button class="btn sm primary" disabled={candidates.busy} onclick={() => void candidates.adoptOne(c)}>采纳</button>
              <button class="btn sm" disabled={candidates.busy} onclick={() => void rectifyOne(c)}>整改</button>
              <button class="btn sm ghost-danger" disabled={candidates.busy} onclick={() => void candidates.discardOne(c)}>丢弃</button>
            {/if}
            <button class="btn sm" disabled={candidates.busy} onclick={() => void snapshot.restoreLatest(c.chapter)} title="把该章还原到最新快照（采纳前自动快照的还原入口）">还原快照</button>
          </div>
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .overview {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(860px, calc(100vw - var(--tree-w) - var(--rail-w) - 80px));
    z-index: 90;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border-left: 1px solid var(--line);
    box-shadow: var(--shadow-pop);
    font-family: var(--ui-font);
  }
  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    height: 46px;
    border-bottom: 1px solid var(--line);
    user-select: none;
  }
  .title {
    font-size: 13px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .title .n {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--accent);
    color: #fff;
    font-size: 10.5px;
    line-height: 18px;
    text-align: center;
  }
  .tabs {
    display: flex;
    gap: 4px;
  }
  .tab {
    height: 24px;
    padding: 0 10px;
    font-size: 11.5px;
    border-radius: 12px;
    border: 1px solid var(--line);
    color: var(--muted);
    transition: all var(--t-hover);
  }
  .tab.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .tab:not(.on):hover {
    border-color: var(--accent-line);
    color: var(--accent);
  }
  .snap {
    font-size: 11px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  .actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .busy {
    color: var(--accent);
    font-size: 12px;
  }
  .chk {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
    cursor: pointer;
  }
  .chk input {
    accent-color: var(--accent);
  }
  .btn {
    height: 26px;
    padding: 0 10px;
    font-size: 12px;
    border-radius: 6px;
    border: 1px solid var(--line);
    transition: all var(--t-hover);
    white-space: nowrap;
  }
  .btn:hover:not(:disabled) {
    background: var(--paper);
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .btn.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 88%, #000);
    border-color: transparent;
  }
  .btn.ghost-danger:hover:not(:disabled) {
    color: var(--danger);
    border-color: var(--danger);
  }
  .icon-btn {
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 5px;
    color: var(--muted);
    transition: background var(--t-hover), color var(--t-hover);
  }
  .icon-btn:hover {
    background: color-mix(in srgb, var(--muted) 12%, transparent);
    color: var(--ink);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .empty {
    border: 1px dashed color-mix(in srgb, var(--muted) 40%, var(--line));
    border-radius: 8px;
    padding: 30px;
    text-align: center;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.9;
  }
  .card {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    transition: border-color var(--t-hover);
  }
  .card:hover {
    border-color: color-mix(in srgb, var(--muted) 45%, var(--line));
  }
  .card.decided {
    opacity: 0.72;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 11.5px;
    color: var(--muted);
  }
  .meta input {
    accent-color: var(--accent);
  }
  .nochk {
    width: 12px;
    flex: none;
  }
  .status-pill {
    flex: none;
    height: 18px;
    padding: 0 7px;
    border-radius: 9px;
    font-size: 10.5px;
    line-height: 18px;
    border: 1px solid var(--line);
  }
  .status-pill.pending {
    color: var(--status-draft);
    border-color: color-mix(in srgb, var(--status-draft) 45%, var(--line));
  }
  .status-pill.adopted {
    color: var(--ok);
    border-color: color-mix(in srgb, var(--ok) 45%, var(--line));
  }
  .status-pill.discarded {
    color: var(--muted);
  }
  .ch {
    font-family: var(--body-font);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    letter-spacing: 0.04em;
    flex: none;
  }
  .kind-pill {
    flex: none;
    height: 17px;
    padding: 0 6px;
    border-radius: 4px;
    font-size: 10px;
    line-height: 17px;
    border: 1px solid var(--line);
    color: var(--muted);
  }
  .kind-pill.append {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
  }
  .kind-pill.replace_all {
    color: var(--status-polish);
    border-color: color-mix(in srgb, var(--status-polish) 40%, var(--line));
  }
  .instr {
    flex: 1;
    font-style: normal;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .instr b {
    color: var(--accent);
    font-weight: 500;
  }
  .time {
    font-variant-numeric: tabular-nums;
    flex: none;
  }
  .diff {
    display: flex;
    padding: 10px 12px;
    gap: 12px;
  }
  .col {
    flex: 1;
    min-width: 0;
  }
  .lbl {
    font-size: 10px;
    letter-spacing: 0.2em;
    color: var(--muted);
    margin-bottom: 4px;
  }
  .old,
  .new {
    font-family: var(--body-font);
    font-size: 12.5px;
    line-height: 1.75;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 210px;
    overflow-y: auto;
  }
  .old {
    color: var(--muted);
    text-decoration: line-through;
    text-decoration-color: var(--strike);
  }
  .new {
    color: var(--ink);
    background: var(--suggest-bg);
    border-radius: 4px;
    padding: 2px 4px;
  }
  .arrow {
    align-self: center;
    color: var(--line);
    flex: none;
  }
  .ops {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
    flex: none;
    padding-right: 2px;
  }
</style>
