<script lang="ts">
  // 结构树：卷/章/场三级，状态点 + 字数；数据全部来自 list_structure（壳不推导）。
  import { statusVar } from '../theme.js';
  import { work } from '../lib/work.svelte.js';
  import type { ChapterNode } from '../lib/types.js';

  function confirmDelete(ch: ChapterNode): void {
    if (window.confirm(`删除「${ch.title}」？文件移入 .novel/trash/（软删，可找回）。`)) {
      void work.deleteChapter(ch.relPath);
    }
  }
</script>

<nav>
  {#if work.structure.length === 0}
    <p class="empty">manuscript 下还没有章节</p>
  {/if}
  {#each work.structure as vol (vol.title)}
    <div class="volume">{vol.title}</div>
    {#each vol.children as ch (ch.relPath)}
      <div
        class="chapter"
        class:open={work.current?.relPath === ch.relPath}
        role="button"
        tabindex="0"
        onclick={() => void work.openChapter(ch)}
        onkeydown={(e) => e.key === 'Enter' && void work.openChapter(ch)}
      >
        <i class="status" style:background={statusVar(ch.status)} title={ch.status ?? '无状态'}
        ></i>
        <span class="title">{ch.title}</span>
        <span class="wc">{ch.wordCount}</span>
        <button
          class="del"
          title="软删进 .novel/trash/"
          onclick={(e) => {
            e.stopPropagation();
            confirmDelete(ch);
          }}>×</button
        >
      </div>
      {#each ch.scenes as sc (ch.relPath + sc.line)}
        <div
          class="scene"
          role="button"
          tabindex="0"
          onclick={() => void work.openChapter(ch, sc.title)}
          onkeydown={(e) => e.key === 'Enter' && void work.openChapter(ch, sc.title)}
        >
          {sc.title}
        </div>
      {/each}
    {/each}
  {/each}
</nav>

<style>
  nav {
    height: 100%;
    overflow-y: auto;
    padding: 8px 0 24px;
    font-size: 13px;
  }
  .empty {
    color: var(--muted);
    padding: 12px;
  }
  .volume {
    padding: 10px 12px 4px;
    color: var(--muted);
    font-size: 12px;
    letter-spacing: 0.08em;
  }
  .chapter {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 10px 6px 14px;
    cursor: pointer;
    border-left: 2px solid transparent;
  }
  .chapter:hover {
    background: var(--paper);
  }
  .chapter.open {
    background: var(--paper);
    border-left-color: var(--accent);
  }
  .status {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
  }
  .title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wc {
    color: var(--muted);
    font-size: 11px;
    flex: none;
  }
  .del {
    color: var(--muted);
    font-size: 14px;
    padding: 0 4px;
    border-radius: 4px;
    opacity: 0;
    flex: none;
  }
  .chapter:hover .del {
    opacity: 1;
  }
  .del:hover {
    color: var(--danger);
  }
  .scene {
    padding: 3px 10px 3px 38px;
    color: var(--muted);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scene:hover {
    color: var(--ink);
  }
</style>
