<script lang="ts">
  // B4 快照 toast：采纳/危险操作后底部浮出，「一键还原」入口不随 toast 消失（顶栏快照常驻）。
  import { iconSvg } from '../lib/icons.js';
  import { snapshot } from '../lib/snapshot.svelte.js';
</script>

{#if snapshot.toast}
  <div class="toast" role="status">
    {@html iconSvg('check', 15, 2.2)}
    <span class="msg">{snapshot.toast.message}</span>
    {#if snapshot.toast.snapshotTime}
      <span class="time">快照 {snapshot.toast.snapshotTime}</span>
    {/if}
    <button class="undo" onclick={() => void snapshot.restoreLatest(snapshot.toast!.relPath)}>
      {@html iconSvg('undo', 12)}
      一键还原
    </button>
    <button class="dismiss" onclick={() => snapshot.dismissToast()} aria-label="关闭">×</button>
  </div>
{/if}

<style>
  .toast {
    position: fixed;
    left: 50%;
    bottom: 26px;
    transform: translateX(-50%);
    z-index: 95;
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-left: 3px solid var(--ok);
    border-radius: 9px;
    box-shadow: var(--shadow-pop);
    padding: 9px 14px;
    font-size: 12.5px;
    white-space: nowrap;
    animation: rise 0.3s var(--ease-fold);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(14px);
    }
  }
  .msg {
    max-width: 40vw;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .time {
    color: var(--muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .undo {
    color: var(--accent);
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .undo:hover {
    text-decoration: underline;
  }
  .dismiss {
    color: var(--muted);
    font-size: 14px;
    padding: 0 2px;
  }
  .dismiss:hover {
    color: var(--ink);
  }
</style>
