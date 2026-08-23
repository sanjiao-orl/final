<script lang="ts">
  // B4 快照 toast：采纳/危险操作后底部浮出，「一键还原」入口不随 toast 消失（顶栏快照常驻）。
  import { iconSvg } from '../lib/icons.js';
  import { snapshot } from '../lib/snapshot.svelte.js';
  import { chat } from '../lib/chat.svelte.js';
  import { ui } from '../lib/ui.svelte.js';

  // T12：notice 引导按钮点击（组件层组合，避免 candidates → chat 循环依赖）：
  // 结构化同步指令预填进聊天输入框草稿（不自动发送）→ AI 面板切到 chat 栏让作者看到草稿 → 关闭本条提示。
  function noticeAction(): void {
    const action = snapshot.notice?.action;
    if (!action) return;
    chat.setDraft(chat.currentDraftKey(), action.prefillChat);
    ui.showCol('chat');
    snapshot.dismissNotice();
  }
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
{#if snapshot.notice}
  <div class="toast notice" role="status" style:bottom={snapshot.toast ? '72px' : '26px'}>
    <span class="msg">{snapshot.notice.message}</span>
    {#if snapshot.notice.action}
      <button class="undo notice-action" onclick={noticeAction}>{snapshot.notice.action.label}</button>
    {/if}
    <button class="dismiss" onclick={() => snapshot.dismissNotice()} aria-label="关闭">×</button>
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
  /* 轻提示变体（采纳后诊断等）：无还原动作，长文可换行，常驻在快照 toast 之上 */
  .toast.notice {
    border-left-color: var(--accent);
    max-width: min(520px, calc(100vw - 40px));
    white-space: normal;
    line-height: 1.5;
    align-items: flex-start;
  }
  /* T12 引导按钮：随 .undo 样式（accent 加粗），长文案换行时不被压缩 */
  .notice-action {
    flex-shrink: 0;
  }
</style>
