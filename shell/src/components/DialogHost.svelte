<script lang="ts">
  // 模态对话框宿主：prompt（单行输入）/ confirm（确认/取消）。
  // Esc=取消；Enter=确定；点遮罩=取消；打开时自动聚焦输入框并全选。
  import { dialog } from '../lib/dialog.svelte.js';

  let inputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (dialog.current?.kind === 'prompt' && inputEl) {
      inputEl.focus();
      inputEl.select();
    }
  });

  function onKeydown(e: KeyboardEvent): void {
    if (!dialog.current) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      dialog.cancel();
    } else if (e.key === 'Enter') {
      e.stopPropagation();
      dialog.ok();
    }
  }
</script>

{#if dialog.current}
  <div class="mask" role="presentation" onmousedown={(e) => { if (e.target === e.currentTarget) dialog.cancel(); }}>
    <div class="box" role="dialog" aria-modal="true" aria-label={dialog.current.message} tabindex="-1" onkeydown={onKeydown}>
      <p class="msg">{dialog.current.message}</p>
      {#if dialog.current.kind === 'prompt'}
        <input
          bind:this={inputEl}
          bind:value={dialog.input}
          placeholder={dialog.current.placeholder ?? ''}
          onkeydown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') dialog.ok();
            if (e.key === 'Escape') dialog.cancel();
          }}
        />
      {/if}
      <div class="ops">
        <button class="btn" onclick={() => dialog.cancel()}>{dialog.current.cancelLabel ?? '取消'}</button>
        <button class="btn primary" class:danger={dialog.current.danger} onclick={() => dialog.ok()}>
          {dialog.current.okLabel ?? (dialog.current.kind === 'prompt' ? '确定' : '确认')}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .mask {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: color-mix(in srgb, #000 30%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .box {
    width: 380px;
    max-width: calc(100vw - 48px);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: var(--shadow-pop);
    padding: 18px 20px 16px;
    font-family: var(--ui-font);
  }
  .msg {
    font-size: 13.5px;
    line-height: 1.7;
    color: var(--ink);
    margin: 0 0 14px;
    white-space: pre-wrap;
  }
  input {
    width: 100%;
    height: 32px;
    padding: 0 10px;
    font-size: 13px;
    background: var(--paper);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 6px;
    outline: none;
    box-sizing: border-box;
    transition: border-color var(--t-hover);
  }
  input:focus {
    border-color: var(--accent);
  }
  .ops {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  .btn {
    height: 30px;
    padding: 0 16px;
    font-size: 12.5px;
    border-radius: 6px;
    border: 1px solid var(--line);
    color: var(--ink);
    transition: all var(--t-hover);
  }
  .btn:hover {
    border-color: var(--muted);
  }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .btn.primary:hover {
    background: color-mix(in srgb, var(--accent) 88%, #000);
  }
  .btn.primary.danger {
    background: var(--danger);
    border-color: var(--danger);
  }
  .btn.primary.danger:hover {
    background: color-mix(in srgb, var(--danger) 88%, #000);
  }
</style>
