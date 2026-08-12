<script lang="ts">
  // 工具卡（B3/B10）：左缘色条分级（绿=完成/蓝=进行/琥珀=挂起），点卡头展开/收起，
  // 参数与结果就地审阅；挂起卡（B6 ask 模式）内嵌「查看审批卡 / 拒绝」。
  import { iconSvg } from '../../lib/icons.js';
  import { approval } from '../../lib/approval.svelte.js';
  import { chat } from '../../lib/chat.svelte.js';
  import type { ToolLine } from '../../lib/chat.svelte.js';

  interface Props {
    tool: ToolLine;
  }
  let { tool }: Props = $props();
  let open = $state(false);

  // 进行中/挂起自动展开（开盖即审阅）
  $effect(() => {
    if (tool.state === 'running' || tool.state === 'pending') open = true;
  });

  const argText = $derived(formatArg(tool.args));
  const resultText = $derived(formatResult(tool.result));
  const pendingKey = $derived(
    tool.state === 'pending' && typeof tool.args === 'object' && tool.args !== null
      ? targetKeyOf(tool.name, tool.args as Record<string, unknown>)
      : null,
  );

  function formatArg(args: unknown): string {
    if (args === undefined) return '';
    if (typeof args === 'string') return args;
    try {
      const entries = Object.entries(args as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' · ');
      return entries || String(args);
    } catch {
      return String(args);
    }
  }

  function formatResult(result: unknown): string {
    if (result === undefined) return '';
    if (typeof result === 'string') return result;
    try {
      const s = JSON.stringify(result, null, 1);
      return s.length > 600 ? s.slice(0, 600) + '…' : s;
    } catch {
      return String(result);
    }
  }

  function targetKeyOf(name: string, args: Record<string, unknown>): string {
    const rel = typeof args.relPath === 'string' ? args.relPath : '';
    if (name === 'write_chapter') return `write:${rel}`;
    if (name === 'delete_chapter') return `delete:${rel}`;
    return 'export';
  }

  function openApproval(): void {
    const req = approval.pending.find((p) => p.callId === tool.id);
    if (req) approval.active = req;
  }

  async function reject(): Promise<void> {
    await chat.resolveApproval('reject');
  }

  function stateColor(): string {
    return 'var(--muted)';
  }
</script>

<div
  class="card"
  class:done={tool.state === 'done'}
  class:running={tool.state === 'running'}
  class:pending-approval={tool.state === 'pending'}
  class:rejected={tool.state === 'rejected'}
  class:open={open}
>
  <div class="head" role="button" tabindex="0" onclick={() => (open = !open)} onkeydown={(e) => e.key === 'Enter' && (open = !open)}>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style:transform={open ? 'none' : 'rotate(-90deg)'} style:color={stateColor()}><path d="M6 9l6 6 6-6"/></svg>
    <span class="tname">{tool.name}</span>
    <span class="targ">{argText}</span>
    <span class="state">
      {#if tool.state === 'running'}<i class="pulse-dot"></i>调用中
      {:else if tool.state === 'pending'}<i class="pulse-dot"></i>挂起待审批
      {:else if tool.state === 'rejected'}已拒绝
      {:else}✓{/if}
    </span>
  </div>

  {#if open}
    <div class="detail">
      <div class="kv"><span class="k">参 数</span><span class="v">{argText || '—'}</span></div>
      {#if resultText}
        <div class="kv"><span class="k">结 果</span><span class="v">{resultText}</span></div>
      {/if}
      {#if tool.state === 'pending' && pendingKey}
        <div class="kv"><span class="k">说 明</span><span class="v">{approval.active?.target ?? ''} · ask 模式下 AI 直调写/删/导出需人工放行(B6)；走暂存采纳路径不弹此卡</span></div>
        <div class="ops">
          <button class="btn sm primary" onclick={openApproval}>查看审批卡</button>
          <button class="btn sm ghost-danger" onclick={() => void reject()}>拒绝</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .card {
    border: 1px solid var(--line);
    border-left: 3px solid var(--muted);
    border-radius: 7px;
    background: var(--panel);
    overflow: hidden;
  }
  .card.done {
    border-left-color: var(--ok);
  }
  .card.running {
    border-left-color: var(--status-polish);
  }
  .card.pending-approval {
    border-left-color: var(--status-draft);
    background: var(--warn-bg);
  }
  .card.rejected {
    border-left-color: var(--danger);
    opacity: 0.75;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 10px;
    cursor: pointer;
    user-select: none;
    font-size: 12px;
    transition: background var(--t-hover);
  }
  .head:hover {
    background: color-mix(in srgb, var(--muted) 5%, transparent);
  }
  .tname {
    font-weight: 600;
    font-size: 12px;
    flex: none;
  }
  .targ {
    color: var(--muted);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 11.5px;
  }
  .state {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 10.5px;
    color: var(--muted);
    flex: none;
  }
  .card.done .state {
    color: var(--ok);
  }
  .card.running .state {
    color: var(--status-polish);
  }
  .card.pending-approval .state {
    color: var(--status-draft);
  }
  .card.rejected .state {
    color: var(--danger);
  }
  .pulse-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
  .detail {
    border-top: 1px solid var(--line);
    padding: 8px 10px;
    font-size: 11.5px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .kv {
    display: flex;
    gap: 8px;
    padding: 2px 0;
  }
  .k {
    flex: none;
    width: 64px;
    color: var(--muted);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    padding-top: 1px;
  }
  .v {
    flex: 1;
    word-break: break-all;
    line-height: 1.6;
  }
  .ops {
    display: flex;
    gap: 7px;
    margin-top: 8px;
  }
  .btn {
    height: 26px;
    padding: 0 10px;
    font-size: 12px;
    border-radius: 6px;
    border: 1px solid var(--line);
    transition: all var(--t-hover);
    white-space: nowrap;
  }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .btn.primary:hover {
    background: color-mix(in srgb, var(--accent) 88%, #000);
    border-color: transparent;
  }
  .btn.ghost-danger:hover {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
