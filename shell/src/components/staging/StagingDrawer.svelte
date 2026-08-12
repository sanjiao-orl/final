<script lang="ts">
  // 暂存抽屉（≤40% 高）：AI 产出候选批量勾选——采纳（落进正文）/整改（按新要求重改）/丢弃。
  // B4：采纳前自动快照（write_chapter 安全阀）+ 采纳 toast 一键还原；B8：采纳留痕（instruction 展示）。
  import { iconSvg } from '../../lib/icons.js';
  import { candidates } from '../../lib/candidates.svelte.js';
  import { settings } from '../../lib/settings.svelte.js';
  import { snapshot } from '../../lib/snapshot.svelte.js';
  import { work } from '../../lib/work.svelte.js';

  let rectifying = $state(false);
  let rectifyText = $state('');

  function startRectify(): void {
    rectifyText = '';
    rectifying = true;
  }

  async function confirmRectify(): Promise<void> {
    const text = rectifyText;
    rectifying = false;
    await candidates.rectifySelected(text);
  }

  function chapterLabel(c: { chapter: string }): string {
    const cur = work.current;
    if (c.chapter === cur?.relPath) return cur.title;
    return c.chapter.split(/[\\/]/).pop()?.replace(/\.md$/, '') ?? c.chapter;
  }

  function timeOf(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  async function adoptSelected(): Promise<void> {
    const count = candidates.selectedCount;
    if (count === 0) return;
    const first = candidates.items.find((i) => candidates.selected.has(i.id));
    const last = first?.chapter ?? work.current?.relPath;
    await candidates.adoptSelected();
    // B4 采纳 toast：无论暂存区是否清空都提示（还原入口常驻顶栏快照）
    if (last) {
      void snapshot.showAdoptedToast(`已采纳 ${count} 条候选 · ${last.split('/').pop()?.replace(/\.md$/, '')}`, last);
    }
  }

  async function adoptOne(c: { id: string; chapter: string }): Promise<void> {
    await candidates.adoptOne(c as never);
    const last = c.chapter || work.current?.relPath;
    if (last) void snapshot.showAdoptedToast(`已采纳 1 条候选 · ${last.split('/').pop()?.replace(/\.md$/, '')}`, last);
  }
</script>

{#if candidates.drawerOpen}
  <div class="drawer">
    <div class="head">
      <span class="title">暂存区{#if candidates.pendingCount > 0}<i class="n">{candidates.pendingCount}</i>{/if}</span>
      <span class="snap" title="B4：采纳前自动快照">
        {@html iconSvg('snapshot', 12)}
        采纳前自动快照，可一键还原
      </span>
      <div class="actions">
        {#if candidates.busy}<span class="busy">处理中…</span>{/if}
        <label class="chk">
          <input
            type="checkbox"
            checked={candidates.items.length > 0 && candidates.selected.size === candidates.items.length}
            onchange={() => candidates.toggleSelectAll()}
          />
          全选
        </label>
        <button class="btn sm primary" disabled={candidates.selectedCount === 0 || candidates.busy} onclick={() => void adoptSelected()} title="选中候选替换进正文并保存（带历史快照）">采纳</button>
        <button class="btn sm" disabled={candidates.selectedCount === 0 || candidates.busy} onclick={startRectify} title="按新要求重新改写选中候选">整改</button>
        <button class="btn sm ghost-danger" disabled={candidates.selectedCount === 0 || candidates.busy} onclick={() => void candidates.discardSelected()} title="丢弃选中候选（记录仍在库中，不再显示）">丢弃</button>
        <button class="icon-btn" onclick={() => candidates.toggleDrawer()} aria-label="收起暂存区">{@html iconSvg('close', 13, 2)}</button>
      </div>
    </div>

    {#if rectifying}
      <div class="rectify">
        <input
          bind:value={rectifyText}
          placeholder="整改要求（对选中的每条候选重新改写）"
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void confirmRectify();
            }
          }}
        />
        <button class="btn sm" onclick={() => void confirmRectify()} disabled={rectifyText.trim() === ''}>确认整改</button>
        <button class="btn sm" onclick={() => (rectifying = false)}>取消</button>
      </div>
    {/if}

    <div class="body">
      {#if candidates.items.length === 0}
        <div class="empty">
          暂存区空。选中正文里的文字，用浮动条发起 AI 改写，产出会先到这里。
          <div class="hint">大改进进暂存裁决；小改可就地浮层打磨（设置可切分流）。</div>
        </div>
      {/if}
      {#each candidates.items as c (c.id)}
        <div class="card" class:decided={c.status !== 'pending'}>
          <div class="meta">
            <input type="checkbox" checked={candidates.selected.has(c.id)} onchange={() => candidates.toggleSelect(c.id)} aria-label="选择候选" />
            <span class="ch">{chapterLabel(c)}</span>
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
              <button class="btn sm primary" disabled={candidates.busy} onclick={() => void adoptOne(c)}>采纳</button>
              <button class="btn sm ghost-danger" disabled={candidates.busy} onclick={() => void candidates.discardOne(c)}>丢弃</button>
            </div>
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .drawer {
    flex: none;
    max-height: 40%;
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--line);
    background: var(--panel);
    font-family: var(--ui-font);
    transition: border-color var(--t-fold);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    height: 38px;
    flex: none;
    border-bottom: 1px solid var(--line);
    user-select: none;
  }
  .title {
    font-size: 12.5px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .title .n {
    min-width: 17px;
    height: 17px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--accent);
    color: #fff;
    font-size: 10.5px;
    line-height: 17px;
    text-align: center;
  }
  .snap {
    font-size: 11px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 5px;
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
    width: 24px;
    height: 24px;
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
  .rectify {
    display: flex;
    gap: 6px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--line);
  }
  .rectify input {
    flex: 1;
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 4px 9px;
    font-size: 12px;
    background: var(--paper);
    color: var(--ink);
    outline: none;
  }
  .body {
    flex: 1;
    overflow-y: auto;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .empty {
    border: 1px dashed color-mix(in srgb, var(--muted) 40%, var(--line));
    border-radius: 8px;
    padding: 26px;
    text-align: center;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.9;
  }
  .empty .hint {
    font-size: 11px;
    opacity: 0.75;
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
  .ch {
    font-family: var(--body-font);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    letter-spacing: 0.04em;
    flex: none;
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
    padding: 9px 12px;
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
    line-height: 1.7;
    display: -webkit-box;
    line-clamp: 3;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: pre-wrap;
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
