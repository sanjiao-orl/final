<script lang="ts">
  import { inbox, DISMISS_REASONS, type DismissReason } from '../../lib/inbox.svelte.js';
  import { work } from '../../lib/work.svelte.js';

  const ACTION_LABEL: Record<string, string> = { ADD: '新增', UPDATE: '更新', DELETE: '撤线', NOOP: '观察' };
  let dismissReason = $state<DismissReason>('误报');
  let reanchorVolume = $state('');

  const timeOf = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
</script>

<div class="list">
  <div class="head">
    <span>裁决收件箱 <b>{inbox.pendingCount}</b></span>
    <span class="head-actions">
      <button
        class="scan"
        disabled={inbox.scanning}
        title="承诺·伏笔补账扫描（便宜档 LLM，批量非热路径；产物入收件箱待裁决）"
        onclick={() => void inbox.scan()}
      >
        {inbox.scanning ? '扫描中…' : '扫描'}
      </button>
    </span>
  </div>
  {#if inbox.lastScan}
    <div class="scan-note">
      上次扫描：嫌疑 {inbox.lastScan.suspectChapters} 章 / {inbox.lastScan.llmCalls} 次判定 → 新提案 {inbox.lastScan.added}（重复跳过 {inbox.lastScan.skipped}）
    </div>
  {/if}

  {#if inbox.entries.length === 0}
    <div class="empty">{inbox.scanning ? '扫描中…' : '收件箱为空——用「扫描」跑一次承诺·伏笔补账，或等写作间隙批量扫'}</div>
  {/if}

  {#each inbox.entries as e (e.id)}
    <div class="row" class:pending={e.status === 'pending'} class:adopted={e.status === 'adopted'} class:discarded={e.status === 'discarded'}>
      <label class="pick">
        <input type="checkbox" disabled={e.status !== 'pending'} checked={inbox.selected.has(e.id)} onchange={() => inbox.toggle(e.id)} />
      </label>
      <div class="body">
        <div class="meta">
          <span class="origin">{e.origin === 'scan' ? '补账扫描' : e.origin === 'radar' ? '预警' : e.origin === 'chat' ? '对话' : '导入'}</span>
          <span class="status {e.status}">{e.status === 'pending' ? '待裁决' : e.status === 'adopted' ? '已采纳' : '已驳回'}</span>
          <time>{timeOf(e.createdAt)}</time>
        </div>
        {#each e.ops as o (o.targetKey + o.action)}
          <div class="op">
            <span class="action {o.action.toLowerCase()}">{ACTION_LABEL[o.action] ?? o.action}</span>
            <span class="key">{o.targetKey}</span>
            <span class="why">{o.rationale}</span>
          </div>
        {/each}
        {#if e.verify}
          <div class="verify" class:ok={e.verify.ok}>{e.verify.ok ? '✅' : '❌'} 回读验证：{e.verify.message}</div>
        {/if}
        {#if e.resolution?.dismiss}
          <div class="dismiss-note">驳回：{e.resolution.dismiss.reason}{e.resolution.dismiss.reanchorVolume ? `（延后至 ${e.resolution.dismiss.reanchorVolume}）` : ''}{e.resolution.dismiss.note ? ` · ${e.resolution.dismiss.note}` : ''}</div>
        {/if}
      </div>
    </div>
  {/each}

  {#if inbox.selectedCount > 0}
    <div class="bulk">
      <span class="sel">已选 {inbox.selectedCount} 条</span>
      <select bind:value={dismissReason} title="驳回理由（必带）：有意延后=一等公民，可带新预计卷">
        {#each DISMISS_REASONS as r}<option value={r}>{r}</option>{/each}
      </select>
      {#if dismissReason === '有意延后'}
        <input class="reanchor" bind:value={reanchorVolume} placeholder="新预计卷（如 卷三）" />
      {/if}
      <button class="adopt" disabled={inbox.busy} onclick={() => void inbox.decide('adopt')}>采纳落账</button>
      <button class="discard" disabled={inbox.busy} onclick={() => void inbox.decide('discard', dismissReason, reanchorVolume)}>驳回</button>
    </div>
  {/if}
  {#if inbox.selectedCount === 0 && inbox.pendingCount > 0}
    <div class="bulk-hint"><button onclick={() => inbox.selectAllPending()}>全选待裁决</button></div>
  {/if}
</div>

<style>
  .list { height: 100%; overflow: auto; background: var(--panel); font-family: var(--ui-font); position: relative; padding-bottom: 56px; }
  .head { height: 38px; padding: 0 12px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); font-size: 12px; font-weight: 600; position: sticky; top: 0; background: var(--panel); z-index: 1; }
  .head b { color: var(--accent); }
  .scan { border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; padding: 3px 10px; font-size: 11px; cursor: pointer; }
  .scan:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .scan:disabled { opacity: 0.6; cursor: default; }
  .scan-note { padding: 6px 12px; color: var(--muted); font-size: 10.5px; border-bottom: 1px dashed var(--line); }
  .empty { padding: 28px 14px; color: var(--muted); font-size: 12px; text-align: center; }
  .row { display: flex; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
  .row.adopted { opacity: 0.65; } .row.discarded { opacity: 0.45; }
  .pick { padding-top: 2px; }
  .body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .meta { display: flex; gap: 8px; align-items: baseline; font-size: 10.5px; color: var(--muted); }
  .origin { color: var(--ink); font-weight: 600; }
  .status.pending { color: var(--accent); font-weight: 600; }
  .status.adopted { color: var(--ok, #2a8); } .status.discarded { color: var(--muted); }
  .meta time { margin-left: auto; }
  .op { display: flex; gap: 6px; align-items: baseline; font-size: 11.5px; min-width: 0; }
  .action { flex: none; font-size: 10px; padding: 0 5px; border-radius: 4px; border: 1px solid var(--line); }
  .action.add { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line)); }
  .action.delete { color: #c33; border-color: color-mix(in srgb, #c33 35%, var(--line)); }
  .key { flex: none; font-family: var(--mono-font, monospace); font-size: 10.5px; color: var(--muted); }
  .why { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .verify { font-size: 10.5px; color: var(--muted); } .verify.ok { color: var(--ok, #2a8); }
  .dismiss-note { font-size: 10.5px; color: var(--muted); }
  .bulk { position: sticky; bottom: 0; left: 0; right: 0; display: flex; gap: 6px; align-items: center; padding: 8px 12px; background: var(--paper); border-top: 1px solid var(--line); }
  .bulk .sel { font-size: 11px; font-weight: 600; }
  .bulk select, .bulk .reanchor { font-size: 11px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: inherit; padding: 3px 6px; }
  .bulk .reanchor { width: 110px; }
  .bulk button { border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; padding: 4px 10px; font-size: 11px; cursor: pointer; }
  .bulk .adopt { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); font-weight: 600; }
  .bulk button:disabled { opacity: 0.5; cursor: default; }
  .bulk-hint { position: sticky; bottom: 0; padding: 8px 12px; background: var(--paper); border-top: 1px solid var(--line); }
  .bulk-hint button { border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--muted); padding: 4px 10px; font-size: 11px; cursor: pointer; }
</style>
