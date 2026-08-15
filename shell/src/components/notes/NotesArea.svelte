<script lang="ts">
  // 作者笔记（壳 v5 §一.2）：作者的私房话，AI 物理不可见。
  // ★ 此数据永不进 chat/AI 上下文——只经 notes store 走 Tauri read_note/write_note，
  //   绝不送进任何 core/MCP 工具调用。别在别处把 notes.content 拼进对话/改写/审阅上下文。
  import { untrack } from 'svelte';
  import { iconSvg } from '../../lib/icons.js';
  import { notes, noteRelPath, chapterNoteId } from '../../lib/notes.svelte.js';
  import { work } from '../../lib/work.svelte.js';

  let open = $state(false);
  let tab = $state<'book' | 'chapter'>('book');
  /** 展开态高度（px），由顶缘拖拽手柄改；收起时固定 32px 只露标题栏。 */
  let height = $state(200);
  let resizing = $state(false);
  let rootEl = $state<HTMLElement | null>(null);

  const chapterOpen = $derived(work.current !== null);
  /** 章稳定 id：frontmatter 稳定 id 优先，拿不到退化为 encodeURIComponent(relPath)（见 chapterNoteId）。 */
  const chapterId = $derived(chapterNoteId(work.current));
  /** 无打开章时本章 tab 无归属：返回 null，effect 保持当前笔记不切走、不误存到 chapters/.md。 */
  const currentRelPath = $derived(
    tab === 'chapter' && !chapterOpen ? null : noteRelPath(tab, chapterId ?? ''),
  );

  const statusText = $derived(
    notes.saving
      ? '保存中…'
      : notes.dirty
        ? '未保存'
        : notes.savedAt > 0
          ? `已保存 ${fmtTime(notes.savedAt)}`
          : '',
  );

  function fmtTime(ms: number): string {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // 切 tab / 当前章变化：flush 旧笔记再 load 新笔记。
  // 用 untrack 包住 flush/load：flush 内部会读 notes.dirty/relPath/saving 等，
  // 若不 untrack 它们会成为 effect 依赖，打字触发 setContent 时会误重载笔记、打断输入。
  $effect(() => {
    if (!open) return;
    const rel = currentRelPath;
    if (rel === null) {
      // 打开章被关掉：把最后一份本章笔记落盘，保持现场不切走
      untrack(() => void notes.flush());
      return;
    }
    untrack(() => {
      void notes.flush().then(() => {
        if (open && currentRelPath === rel) void notes.load(rel);
      });
    });
  });

  function toggleOpen(): void {
    if (open) {
      open = false;
      untrack(() => void notes.flush()); // 收起前落盘防抖待存内容
    } else {
      open = true;
    }
  }

  // ---------- 拖拽调高（pointer 范式：参照 AiPanel.svelte 栏宽拖拽实现） ----------
  function startResize(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.currentTarget as HTMLElement;
    // 捕获指针：拖出窗口/面板边界后松手也能收到 pointerup（jsdom / 某些 WebView2 不支持：忽略）
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // 事件仍走 window 监听，拖拽态可恢复
    }
    resizing = true;
    e.preventDefault();
  }
  function moveResize(e: PointerEvent): void {
    if (!resizing) return;
    const el = rootEl;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const rect = el.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    // 手柄在顶缘：向上拖=变高。高度 = 底缘 - 当前指针 Y
    const next = rect.bottom - e.clientY;
    const max = Math.max(120, Math.floor(parentRect.height * 0.6));
    height = Math.max(120, Math.min(max, Math.round(next)));
  }
  function endResize(): void {
    resizing = false;
  }
</script>

<div
  class="notes"
  class:open
  class:resizing
  bind:this={rootEl}
  style:height={open ? `${height}px` : '32px'}
>
  {#if open}
    <!-- 顶缘 5px 拖拽热区（绝对定位，不占内容高度） -->
    <div
      class="resize-handle"
      onpointerdown={startResize}
      role="separator"
      aria-orientation="horizontal"
      aria-label="拖拽调整笔记高度"
      tabindex="-1"
    ></div>
  {/if}

  <div class="head">
    <button
      class="title-btn"
      onclick={toggleOpen}
      aria-expanded={open}
      title={open ? '收起作者笔记' : '展开作者笔记（AI 不可见）'}
    >
      <span class="caret" class:rot={open}>{@html iconSvg('caret', 12, 2)}</span>
      <span class="title">作者笔记</span>
      <span class="priv">AI 不可见</span>
    </button>
    {#if open}
      <div class="tabs">
        <button class="tab" class:active={tab === 'book'} onclick={() => (tab = 'book')}>全书</button>
        <button
          class="tab"
          class:active={tab === 'chapter'}
          onclick={() => (tab = 'chapter')}
          disabled={!chapterOpen}
          title={chapterOpen ? '' : '先打开一章才能记本章笔记'}
        >本章</button>
      </div>
      <span class="status" class:err={notes.error !== null} title={notes.error ?? ''}>{statusText}</span>
    {/if}
  </div>

  {#if open}
    <div class="body">
      {#if notes.unavailable}
        <p class="empty">桌面版可用作者笔记</p>
      {:else}
        <textarea
          class="input"
          value={notes.content}
          placeholder="作者私房话：只有你本机能看（AI 物理不可见），自动保存…"
          spellcheck="false"
          oninput={(e) => notes.setContent((e.currentTarget as HTMLTextAreaElement).value)}
        ></textarea>
      {/if}
    </div>
  {/if}
</div>

<svelte:window onpointermove={moveResize} onpointerup={endResize} onpointercancel={endResize} />

<style>
  .notes {
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--panel);
    border-top: 1px solid var(--line);
    font-family: var(--ui-font);
    overflow: hidden;
    position: relative;
  }
  .notes.resizing {
    user-select: none;
  }
  .resize-handle {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 5px;
    cursor: row-resize;
    z-index: 2;
    background: transparent;
    touch-action: none;
  }
  .resize-handle::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 2px;
    height: 1px;
    background: transparent;
    transition: background var(--t-hover);
  }
  .resize-handle:hover::after,
  .notes.resizing .resize-handle::after {
    background: var(--accent);
  }
  .head {
    flex: none;
    height: 32px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
    user-select: none;
    border-bottom: 1px solid var(--line);
  }
  .title-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 100%;
    padding: 0 4px;
    font-size: 12px;
    color: var(--ink);
    background: transparent;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    transition: background var(--t-hover);
  }
  .title-btn:hover {
    background: color-mix(in srgb, var(--muted) 8%, transparent);
  }
  .caret {
    display: inline-flex;
    color: var(--muted);
    transition: transform var(--t-hover);
  }
  .caret.rot {
    transform: rotate(90deg);
  }
  .title {
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: 0.05em;
  }
  .priv {
    font-size: 10px;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 0 5px;
    line-height: 16px;
    background: color-mix(in srgb, var(--muted) 6%, transparent);
    white-space: nowrap;
  }
  .tabs {
    display: flex;
    gap: 2px;
    margin-left: 4px;
  }
  .tab {
    height: 22px;
    padding: 0 8px;
    font-size: 11.5px;
    color: var(--muted);
    border: none;
    border-radius: 5px;
    background: transparent;
    cursor: pointer;
    transition: background var(--t-hover), color var(--t-hover);
  }
  .tab:hover:not(:disabled) {
    background: color-mix(in srgb, var(--muted) 8%, transparent);
    color: var(--ink);
  }
  .tab.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .tab:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .status {
    margin-left: auto;
    font-size: 10.5px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .status.err {
    color: var(--danger);
  }
  .body {
    flex: 1;
    min-height: 0;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
  }
  .empty {
    margin: auto;
    color: var(--muted);
    font-size: 12px;
    text-align: center;
  }
  .input {
    flex: 1;
    width: 100%;
    resize: none;
    border: none;
    outline: none;
    background: transparent;
    color: var(--ink);
    font-family: var(--ui-font);
    font-size: 13.5px;
    line-height: 1.6;
    padding: 4px 6px;
    border-radius: 6px;
    transition: background var(--t-hover);
  }
  .input:focus {
    background: color-mix(in srgb, var(--muted) 4%, transparent);
  }
</style>
