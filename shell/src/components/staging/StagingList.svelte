<script lang="ts">
  import { candidates } from '../../lib/candidates.svelte.js';
  import { work } from '../../lib/work.svelte.js';
  const KIND_LABEL: Record<string, string> = { replace: '替换', append: '追加', replace_all: '整章' };
  const chapterLabel = (chapter: string) => work.current?.relPath === chapter ? work.current.title : chapter.split(/[\\/]/).pop()?.replace(/\.md$/, '') ?? chapter;
  const timeOf = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
</script>
<div class="list">
  <div class="head"><span>暂存候选 <b>{candidates.pendingCount}</b></span><button onclick={() => void candidates.openOverview()}>全览</button></div>
  {#if candidates.generating}<div class="generating">● AI 生成中…{candidates.generating.text.length} 字<button class="cancel-gen" title="中止本次 AI 生成（已生成的部分不进暂存区）" onclick={() => candidates.abortGenerate()}>取消</button></div>{/if}
  {#if candidates.items.length === 0 && !candidates.generating}<div class="empty">暂无暂存候选</div>{/if}
  {#each candidates.items as c (c.id)}
    <button class="row" class:selected={candidates.viewingId === c.id} onclick={() => (candidates.viewingId = c.id)}>
      <span class="chapter">{chapterLabel(c.chapter)}</span><span class="kind">{KIND_LABEL[c.kind] ?? c.kind}</span>
      <span class="instruction">{c.instruction || '润色'}</span><time>{timeOf(c.createdAt)}</time>
    </button>
  {/each}
</div>
<style>
  .list { height: 100%; overflow: auto; background: var(--panel); font-family: var(--ui-font); }
  .head { height: 38px; padding: 0 12px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); font-size: 12px; font-weight: 600; } .head b { color: var(--accent); }
  button { border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; padding: 4px 9px; cursor: pointer; } .row { width: 100%; display: grid; grid-template-columns: 1fr auto; gap: 4px 7px; text-align: left; padding: 10px 12px; border-width: 0 0 1px; border-radius: 0; } .row:hover, .row.selected { background: var(--paper); }
  .chapter { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .kind { justify-self: end; color: var(--accent); font-size: 10px; } .instruction { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } time { color: var(--muted); font-size: 10px; }
  .generating { padding: 10px 12px; color: var(--accent); font-size: 11px; animation: pulse 1.5s ease-in-out infinite; display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .cancel-gen { flex: none; height: 20px; padding: 0 8px; font-size: 10.5px; border-radius: 5px; border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line)); background: transparent; color: var(--accent); cursor: pointer; animation: none; transition: all var(--t-hover); }
  .cancel-gen:hover { border-color: var(--accent); } .empty { padding: 28px 14px; color: var(--muted); font-size: 12px; text-align: center; } @keyframes pulse { 50% { opacity: .55; } }
</style>