<script lang="ts">
  // 暂存抽屉：AI 产出的候选项批量勾选——采纳（落进正文）/整改（按新要求重改）/丢弃。
  // 候选持久化在 core；这里只渲染 + 发指令。正文里的内联删除线装饰与本列表同源。
  import { candidates } from '../lib/candidates.svelte.js';
  import { work } from '../lib/work.svelte.js';

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

  function chapterLabel(c: { chapter: string }): string | null {
    if (c.chapter === work.current?.relPath) return null;
    // relPath 末段当章名（树里标题一致，避免多查一轮）
    return c.chapter.split(/[\\/]/).pop()?.replace(/\.md$/, '') ?? c.chapter;
  }
</script>

{#if candidates.drawerOpen}
  <div class="drawer">
    <div class="bar">
      <label class="all">
        <input
          type="checkbox"
          checked={candidates.items.length > 0 && candidates.selected.size === candidates.items.length}
          onchange={() => candidates.toggleSelectAll()}
        />
        全选
      </label>
      <span class="count">暂存区 {candidates.items.length} 条{candidates.selectedCount > 0 ? `（已选 ${candidates.selectedCount}）` : ''}</span>
      <span class="spacer"></span>
      {#if candidates.busy}
        <span class="busy">处理中…</span>
      {/if}
      <button
        class="adopt"
        disabled={candidates.selectedCount === 0 || candidates.busy}
        onclick={() => void candidates.adoptSelected()}
        title="选中候选替换进正文并保存（带历史快照）">采纳</button
      >
      <button
        disabled={candidates.selectedCount === 0 || candidates.busy}
        onclick={startRectify}
        title="按新要求重新改写选中候选">整改</button
      >
      <button
        class="discard"
        disabled={candidates.selectedCount === 0 || candidates.busy}
        onclick={() => void candidates.discardSelected()}
        title="丢弃选中候选（记录仍在库中，不再显示）">丢弃</button
      >
      <button class="close" onclick={() => candidates.toggleDrawer()} aria-label="收起暂存区">×</button>
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
        <button onclick={() => void confirmRectify()} disabled={rectifyText.trim() === ''}>确认整改</button>
        <button onclick={() => (rectifying = false)}>取消</button>
      </div>
    {/if}

    <div class="list">
      {#if candidates.items.length === 0}
        <p class="empty">暂存区空。选中正文里的文字，用浮动条发起 AI 改写，产出会先到这里。</p>
      {/if}
      {#each candidates.items as c (c.id)}
        <label class="item">
          <input type="checkbox" checked={candidates.selected.has(c.id)} onchange={() => candidates.toggleSelect(c.id)} />
          <span class="body">
            <span class="meta">
              <span class="instr">{c.instruction || '润色'}</span>
              {#if chapterLabel(c)}<span class="chap">{chapterLabel(c)}</span>{/if}
            </span>
            <span class="text">
              <del>{c.original}</del>
              <ins>{c.proposed}</ins>
            </span>
          </span>
        </label>
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
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
  }
  .all {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--muted);
  }
  .count {
    color: var(--muted);
  }
  .spacer {
    flex: 1;
  }
  .busy {
    color: var(--accent);
  }
  .bar button {
    font-size: 12px;
    padding: 3px 12px;
    border-radius: 6px;
    color: var(--ink);
    border: 1px solid var(--line);
  }
  .bar button:hover:not(:disabled) {
    background: var(--paper);
  }
  .bar button:disabled {
    opacity: 0.4;
  }
  .bar button.adopt {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .bar button.discard:hover:not(:disabled) {
    color: var(--danger);
    border-color: var(--danger);
  }
  .bar .close {
    border: none;
    font-size: 15px;
    padding: 0 4px;
  }
  .rectify {
    display: flex;
    gap: 6px;
    padding: 8px 12px;
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
  .rectify button {
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 6px;
    border: 1px solid var(--line);
    color: var(--ink);
  }
  .list {
    overflow-y: auto;
    padding: 6px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .empty {
    color: var(--muted);
    font-size: 12px;
    padding: 8px 0;
  }
  .item {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 7px 9px;
    cursor: pointer;
  }
  .item:hover {
    background: var(--paper);
  }
  .item input {
    margin-top: 3px;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .meta {
    display: flex;
    gap: 8px;
    font-size: 11px;
  }
  .instr {
    color: var(--accent);
  }
  .chap {
    color: var(--muted);
  }
  .text {
    font-size: 12.5px;
    line-height: 1.6;
    display: -webkit-box;
    line-clamp: 3;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .text del {
    color: var(--muted);
    text-decoration-color: var(--danger);
    margin-right: 6px;
  }
  .text ins {
    color: var(--accent);
    text-decoration: none;
    border-bottom: 1px dashed var(--accent);
  }
</style>
