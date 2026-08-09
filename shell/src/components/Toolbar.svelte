<script lang="ts">
  // 顶栏：作品名、当前章+脏标记、保存/导出/删除、暂存抽屉、打字机/明暗/专注/右栏开关。
  import { candidates } from '../lib/candidates.svelte.js';
  import { ui } from '../lib/ui.svelte.js';
  import { work } from '../lib/work.svelte.js';

  interface Props {
    onSave: () => void;
  }
  let { onSave }: Props = $props();

  function confirmDelete(): void {
    const cur = work.current;
    if (!cur) return;
    if (window.confirm(`删除「${cur.title}」？文件移入 .novel/trash/（软删，可找回）。`)) {
      void work.deleteChapter(cur.relPath);
    }
  }
</script>

<header>
  <span class="brand" title={work.workDir}>{work.workName || '小说写作工作台'}</span>

  <span class="chapter">
    {#if work.current}
      {work.current.title}
      {#if work.dirty}<i class="dot" title="未保存"></i>{/if}
      {#if work.saving}<span class="muted">保存中…</span>{/if}
    {/if}
  </span>

  <span class="spacer"></span>

  <button onclick={onSave} disabled={!work.current || work.saving} title="Ctrl+S">保存</button>
  <button onclick={() => void work.exportAll()} title="全稿导出 txt 到作品文件夹根">导出</button>
  <button
    class="danger"
    onclick={confirmDelete}
    disabled={!work.current}
    title="软删当前章进 .novel/trash/">删除</button>
  <button
    class:active={candidates.drawerOpen}
    onclick={() => candidates.toggleDrawer()}
    title="暂存区：AI 产出候选，批量采纳/整改/丢弃">
    暂存{#if candidates.pendingCount > 0}<i class="badge">{candidates.pendingCount}</i>{/if}
  </button>
  <span class="sep"></span>
  <button class:active={ui.typewriter} onclick={() => ui.toggleTypewriter()} title="打字机滚动：光标锁 42%">
    打字机</button>
  <button onclick={() => ui.toggleMode()} title="明暗切换">{ui.mode === 'light' ? '暗' : '亮'}</button>
  <button class:active={ui.focus} onclick={() => ui.toggleFocus()} title="F8 专注模式">专注</button>
  <button class:active={ui.rightOpen} onclick={() => ui.toggleRight()} title="Ctrl+J AI 面板">AI</button>
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 42px;
    padding: 0 12px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    flex: none;
  }
  .brand {
    font-weight: 600;
    font-size: 14px;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chapter {
    margin-left: 12px;
    font-size: 13px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--danger);
    display: inline-block;
  }
  .badge {
    display: inline-block;
    min-width: 15px;
    height: 15px;
    line-height: 15px;
    margin-left: 5px;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    font-size: 10px;
    text-align: center;
    padding: 0 3px;
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
  button {
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--ink);
  }
  button:hover:not(:disabled) {
    background: var(--paper);
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button.active {
    color: var(--accent);
    font-weight: 600;
  }
  button.danger:hover:not(:disabled) {
    color: var(--danger);
  }
  .sep {
    width: 1px;
    height: 18px;
    background: var(--line);
    margin: 0 4px;
  }
</style>
