<script lang="ts">
  // B6 审批卡：480px 居中模态。遮罩点击不关闭（危险操作必须显式选择）；
  // 三档按钮固定顺序 拒绝 / 允许一次 / 允许本会话；底部 ask/auto/yolo 指示。
  import { tick } from 'svelte';
  import { approval } from '../../lib/approval.svelte.js';
  import { chat } from '../../lib/chat.svelte.js';
  import { settings, APPROVAL_MODE_LABELS } from '../../lib/settings.svelte.js';
  import { work } from '../../lib/work.svelte.js';

  const req = $derived(approval.active);
  let cardEl = $state<HTMLDivElement | null>(null);
  let primaryBtn = $state<HTMLButtonElement | null>(null);

  // 模态打开后焦点落到「允许,本会话不再询问」主操作按钮（参考 dialog store 的 prompt/confirm 模式）
  $effect(() => {
    if (req) {
      void tick().then(() => primaryBtn?.focus());
    }
  });

  /** 影响面：当前章字数（write/delete 时）与目标。 */
  const impact = $derived.by(() => {
    const r = req;
    if (!r) return null;
    const target = r.target;
    const cur = work.current?.relPath === target || (r.args.relPath !== undefined && String(r.args.relPath) === work.current?.relPath)
      ? work.current
      : null;
    return {
      target,
      currentWc: cur ? countOf(cur) : null,
    };
  });

  function countOf(cur: { savedMd: string }): number {
    return cur.savedMd.replace(/\s/g, '').length;
  }

  async function decide(verdict: 'once' | 'session' | 'reject'): Promise<void> {
    await chat.resolveApproval(verdict);
  }

  function operationDesc(name: string): string {
    if (name === 'write_chapter') return '整章覆写';
    if (name === 'delete_chapter') return '软删（进回收站）';
    return '全稿导出';
  }
</script>

{#if req}
  <div class="overlay" id="approval-overlay" data-ai-zone role="dialog" aria-modal="true" aria-labelledby="approval-title">
    <div class="card" bind:this={cardEl}>
      <div class="head">
        <span class="title" id="approval-title">审批 · 危险操作</span>
        <span class="tag" title={`当前审批模式：${settings.approvalMode}`}>{APPROVAL_MODE_LABELS[settings.approvalMode]}模式挂起</span>
      </div>
      <div class="body">
        AI 请求绕过暂存区，直接改动作品文件。这是写操作，且不经人工裁决路径。
        <div class="tool-line">
          <span class="tname">{req.name}</span>
          <span class="targ">{req.target} · {operationDesc(req.name)}</span>
        </div>
        <div class="impact">
          <div class="cell">
            <div class="k">影 响</div>
            <div class="v">{impact?.currentWc !== null && impact?.currentWc !== undefined ? `${impact.currentWc} 字` : '—'}</div>
          </div>
          <div class="cell">
            <div class="k">快 照</div>
            <div class="v">放行前自动快照(B4)</div>
          </div>
          <div class="cell">
            <div class="k">拒绝补偿</div>
            <div class="v">快照/回收站还原</div>
          </div>
        </div>
      </div>
      <div class="ops">
        <button class="btn ghost-danger" onclick={() => void decide('reject')}>拒绝</button>
        <button class="btn" onclick={() => void decide('once')}>允许一次</button>
        <button class="btn primary" bind:this={primaryBtn} onclick={() => void decide('session')}>允许,本会话不再询问</button>
      </div>
      <div class="foot">
        审批模式(B6)
        <span class="modes">
          <span class="mini-mode" class:on={settings.approvalMode === 'ask'} title={APPROVAL_MODE_LABELS.ask}>ask</span>
          <span class="mini-mode" class:on={settings.approvalMode === 'auto'} title={APPROVAL_MODE_LABELS.auto}>auto</span>
          <span class="mini-mode" class:on={settings.approvalMode === 'yolo'} title={APPROVAL_MODE_LABELS.yolo}>yolo</span>
        </span>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--ink) 22%, transparent);
    z-index: 90;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fade 0.25s var(--ease-fold);
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .card {
    width: 480px;
    max-width: calc(100vw - 40px);
    background: var(--panel);
    border: 1px solid var(--line);
    border-top: 3px solid var(--status-draft);
    border-radius: 12px;
    box-shadow: var(--shadow-modal);
    overflow: hidden;
    animation: rise 0.25s var(--ease-fold);
  }
  @keyframes rise {
    from {
      transform: translateY(10px) scale(0.98);
    }
  }
  .head {
    padding: 16px 20px 0;
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .title {
    font-size: 14.5px;
    font-weight: 700;
  }
  .tag {
    font-size: 10.5px;
    padding: 2px 8px;
    border-radius: 9px;
    background: var(--warn-bg);
    color: var(--status-draft);
    letter-spacing: 0.06em;
  }
  .body {
    padding: 12px 20px 16px;
    font-size: 12.5px;
    line-height: 1.8;
  }
  .tool-line {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 8px 11px;
    margin: 8px 0;
    border: 1px solid var(--line);
    border-radius: 7px;
    background: var(--paper);
  }
  .tname {
    font-weight: 600;
  }
  .targ {
    color: var(--muted);
    font-size: 11.5px;
  }
  .impact {
    display: flex;
    gap: 10px;
    margin-top: 10px;
  }
  .cell {
    flex: 1;
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 8px 11px;
  }
  .k {
    font-size: 10px;
    letter-spacing: 0.2em;
    color: var(--muted);
    margin-bottom: 3px;
  }
  .v {
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .ops {
    display: flex;
    gap: 8px;
    padding: 0 20px 14px;
  }
  .btn {
    flex: 1;
    height: 32px;
    padding: 0 10px;
    font-size: 12.5px;
    border-radius: 6px;
    border: 1px solid var(--line);
    transition: all var(--t-hover);
    white-space: nowrap;
  }
  .btn:hover {
    border-color: var(--muted);
  }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .btn.primary:hover {
    background: color-mix(in srgb, var(--accent) 88%, #000);
    border-color: transparent;
  }
  .btn.ghost-danger:hover {
    border-color: var(--danger);
    color: var(--danger);
  }
  .foot {
    border-top: 1px solid var(--line);
    padding: 8px 20px;
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11px;
    color: var(--muted);
  }
  .modes {
    display: flex;
    gap: 3px;
    margin-left: auto;
  }
  .mini-mode {
    font-size: 10.5px;
    padding: 1px 7px;
    border-radius: 8px;
    border: 1px solid var(--line);
    color: var(--muted);
  }
  .mini-mode.on {
    border-color: var(--status-draft);
    color: var(--status-draft);
    background: var(--warn-bg);
  }
</style>
