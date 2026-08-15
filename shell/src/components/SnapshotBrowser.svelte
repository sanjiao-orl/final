<script lang="ts">
  // 快照浏览器（v5 新增）：Toolbar 弹出，列当前章快照 + 点选预览 + 还原按钮。
  // 数据走 snapshot store 的 listForChapter / preview / restore；不再走 dialog.confirm（避免老路径）。
  import { onMount } from 'svelte';
  import { iconSvg } from '../lib/icons.js';
  import { work } from '../lib/work.svelte.js';
  import { snapshot } from '../lib/snapshot.svelte.js';

  interface Props {
    open: boolean;
    onClose: () => void;
  }
  let { open, onClose }: Props = $props();

  type LoadState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; items: Array<{ path: string; timestamp: string }> }
    | { kind: 'error'; message: string };

  let listState = $state<LoadState>({ kind: 'idle' });
  let selectedPath = $state<string | null>(null);
  let previewState = $state<{ path: string | null; text: string; loading: boolean }>({
    path: null,
    text: '',
    loading: false,
  });
  let restoring = $state(false);

  const chapterRelPath = $derived(work.current?.relPath ?? null);
  const chapterTitle = $derived(work.current?.title ?? '未打开章节');

  async function reloadList(): Promise<void> {
    if (!chapterRelPath) return;
    listState = { kind: 'loading' };
    try {
      const items = await snapshot.listForChapter(chapterRelPath);
      listState = { kind: 'ready', items };
      // 默认选最新一条（与原 openSnapshot 行为一致）
      if (items[0]?.path !== selectedPath) {
        selectedPath = items[0]?.path ?? null;
        if (selectedPath) await loadPreview(selectedPath);
        else previewState = { path: null, text: '', loading: false };
      }
    } catch (err) {
      listState = {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function loadPreview(path: string): Promise<void> {
    previewState = { path, text: '', loading: true };
    const text = await snapshot.preview(path);
    // 仅当用户在等待本条预览时才落值（避免快速切换抖动）
    if (previewState.path === path) {
      previewState = { path, text, loading: false };
    }
  }

  async function pick(path: string): Promise<void> {
    selectedPath = path;
    await loadPreview(path);
  }

  async function restore(): Promise<void> {
    if (!chapterRelPath || !selectedPath || restoring || snapshot.busy) return;
    restoring = true;
    try {
      const ok = await snapshot.restore(chapterRelPath, selectedPath);
      if (ok) onClose();
    } finally {
      restoring = false;
    }
  }

  function onMask(e: MouseEvent): void {
    if (e.target === e.currentTarget) onClose();
  }

  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      // 捕获阶段拦截：本模态独占这一级 Esc，别落到 App 的全局 handler 把 AI 面板一起收掉（Esc 逐级语义）。
      e.stopImmediatePropagation();
      onClose();
    }
  }

  $effect(() => {
    if (open && chapterRelPath) {
      void reloadList();
    }
    if (open && !chapterRelPath) {
      listState = { kind: 'idle' };
      selectedPath = null;
      previewState = { path: null, text: '', loading: false };
    }
  });

  onMount(() => {
    // capture=true：赶在 App 的 <svelte:window> 冒泡监听之前拿到 Esc（配合 stopImmediatePropagation）。
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  function shortStamp(ts: string): string {
    // ts = '<stamp>.md' 或其它时间戳原样，把 .md 丢掉
    return ts.replace(/\.md$/i, '');
  }
</script>

{#if open}
  <div class="mask" role="presentation" data-ai-zone onmousedown={onMask}>
    <div class="card" role="dialog" aria-modal="true" aria-label="历史快照浏览器">
      <div class="head">
        <span class="title">历史快照</span>
        <span class="sub">{chapterTitle}</span>
        <button class="close" onclick={onClose} aria-label="关闭">×</button>
      </div>
      <div class="body">
        <div class="list">
          {#if !chapterRelPath}
            <p class="empty">打开一个章节后可浏览/还原它的历史快照。</p>
          {:else if listState.kind === 'loading'}
            <p class="empty">加载快照列表…</p>
          {:else if listState.kind === 'error'}
            <p class="empty err">加载失败：{listState.message}</p>
          {:else if listState.kind === 'ready' && listState.items.length === 0}
            <p class="empty">当前章还没有历史快照（保存覆写时自动滚动，最多 20 份）。</p>
          {:else if listState.kind === 'ready'}
            <ul>
              {#each listState.items as s (s.path)}
                <li>
                  <button
                    class="row"
                    class:on={selectedPath === s.path}
                    onclick={() => void pick(s.path)}
                  >
                    {@html iconSvg('snapshot', 13)}
                    <span class="ts">{shortStamp(s.timestamp)}</span>
                    <span class="rel">{s.path.split('/').pop()}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
        <div class="preview">
          {#if !selectedPath}
            <p class="empty">选择左侧一条快照，预览会出现在这里。</p>
          {:else if previewState.loading}
            <p class="empty">加载预览…</p>
          {:else}
            <pre>{previewState.text || '(空)'}</pre>
          {/if}
        </div>
      </div>
      <div class="foot">
        <span class="hint">
          {snapshot.busy ? '正在还原…' : '还原会清掉当前未保存改动，写回前自动留一份新快照'}
        </span>
        <button class="btn ghost" onclick={onClose}>关闭</button>
        <button
          class="btn primary"
          onclick={() => void restore()}
          disabled={!selectedPath || restoring || snapshot.busy || !chapterRelPath}
          title={selectedPath ? `还原 ${selectedPath.split('/').pop()}` : '先选一条快照'}
        >
          {restoring ? '还原中…' : '还原此快照'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .mask {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.28);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 90;
  }
  .card {
    width: var(--overlay-modal, 480px);
    max-width: calc(100vw - 40px);
    max-height: calc(100vh - 60px);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: var(--shadow-modal);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--line);
  }
  .title {
    font-size: 13.5px;
    font-weight: 600;
  }
  .sub {
    flex: 1;
    font-size: 11.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .close {
    width: 22px;
    height: 22px;
    border-radius: 5px;
    color: var(--muted);
    font-size: 18px;
    line-height: 1;
    transition: background var(--t-hover), color var(--t-hover);
  }
  .close:hover {
    background: color-mix(in srgb, var(--muted) 12%, transparent);
    color: var(--ink);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    border-bottom: 1px solid var(--line);
  }
  .list {
    width: 48%;
    flex: none;
    border-right: 1px solid var(--line);
    overflow-y: auto;
    padding: 8px;
  }
  .list ul {
    display: flex;
    flex-direction: column;
    gap: 3px;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    font-size: 11.5px;
    border-radius: 5px;
    text-align: left;
    color: var(--ink);
    transition: background var(--t-hover);
  }
  .row:hover {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
  }
  .row.on {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .row .ts {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }
  .row.on .ts {
    color: var(--accent);
  }
  .row .rel {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    color: var(--muted);
  }
  .preview {
    flex: 1;
    min-width: 0;
    overflow: auto;
    padding: 10px 12px;
    background: var(--paper);
  }
  .preview pre {
    margin: 0;
    font-family: var(--body-font);
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--ink);
  }
  .foot {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: var(--panel);
  }
  .foot .hint {
    flex: 1;
    font-size: 10.5px;
    color: var(--muted);
  }
  .btn {
    height: 28px;
    padding: 0 12px;
    border-radius: 6px;
    border: 1px solid var(--line);
    font-size: 12px;
    transition: background var(--t-hover), color var(--t-hover), border-color var(--t-hover);
  }
  .btn.ghost:hover {
    border-color: var(--muted);
  }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .btn.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 88%, #000);
    border-color: transparent;
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .empty {
    font-size: 11.5px;
    color: var(--muted);
    margin: 0;
    padding: 10px 8px;
    line-height: 1.55;
  }
  .empty.err {
    color: var(--danger);
  }
</style>
