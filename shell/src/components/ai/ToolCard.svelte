<script lang="ts">
  // 工具卡（B3/B10）：左缘色条分级（绿=完成/蓝=进行/琥珀=挂起），点卡头展开/收起，
  // 参数与结果就地审阅；挂起卡（B6 ask 模式）内嵌「查看审批卡 / 拒绝」。
  // D3：结果截 600 字符处加「看全文」展开完整 JSON（pre 滚动区）；ToolsColumn 外部可
  // 通过 forceOpen='open'|'closed' 强控展开态（用于"展开全部/收起全部"+ ChatColumn 摘要跳转定位）。
  import { iconSvg } from '../../lib/icons.js';
  import { approval } from '../../lib/approval.svelte.js';
  import { chat } from '../../lib/chat.svelte.js';
  import { WRITE_KEY_PREFIX, DELETE_KEY_PREFIX, EXPORT_KEY } from '../../lib/paths.js';
  import type { ToolLine } from '../../lib/chat.svelte.js';

  interface Props {
    tool: ToolLine;
    /** 外部强控展开：'open' 强制展开 / 'closed' 强制折叠 / undefined 用默认行为。 */
    forceOpen?: 'open' | 'closed' | undefined;
  }
  let { tool, forceOpen = undefined }: Props = $props();
  let open = $state(false);
  /** 结果是否展示完整 JSON（D3）；false 时显示截断版本。 */
  let showFull = $state(false);

  // 进行中/挂起自动展开（开盖即审阅）—— 外部未强制折叠时才生效
  $effect(() => {
    if (forceOpen === 'closed') return;
    if (tool.state === 'running' || tool.state === 'pending') open = true;
  });

  /** 最终展开态：forceOpen 优先；其次内部 open 与运行中自动展开的并集。 */
  const effectiveOpen = $derived(
    forceOpen === 'open'
      ? true
      : forceOpen === 'closed'
        ? false
        : open || tool.state === 'running' || tool.state === 'pending',
  );

  function toggle(): void {
    if (forceOpen !== undefined) return; // 外部强控时不响应用户点击
    open = !open;
  }

  // 耗时：进行中/挂起每 500ms 刷新当前时间，终态稳定。startedAt 来自 chat.toolStarted（store WeakMap）。
  const startedAt = $derived(chat.toolStarted(tool));
  let now = $state(Date.now());
  $effect(() => {
    if (tool.state === 'running' || tool.state === 'pending') {
      const id = setInterval(() => {
        now = Date.now();
      }, 500);
      return () => clearInterval(id);
    }
    now = Date.now(); // 终态时把"now"锁到工具完成那一瞬
  });
  const elapsedText = $derived.by(() => {
    if (!startedAt) return '';
    const sec = Math.max(0, (now - startedAt) / 1000);
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}m${s}s`;
  });

  const argText = $derived(formatArg(tool.args));
  const shortResultText = $derived(formatShort(tool.result));
  const fullResultText = $derived(formatFull(tool.result));
  const resultTruncated = $derived(isTruncated(tool.result));
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

  /** 短结果：字符串直接截 600，JSON 缩进 1 空格后截 600。 */
  function formatShort(result: unknown): string {
    if (result === undefined) return '';
    if (typeof result === 'string') {
      return result.length > 600 ? result.slice(0, 600) + '…' : result;
    }
    try {
      const s = JSON.stringify(result, null, 1);
      return s.length > 600 ? s.slice(0, 600) + '…' : s;
    } catch {
      return String(result);
    }
  }

  /** 完整结果：用于"看全文"—— JSON 缩进 2 空格，字符串原样。 */
  function formatFull(result: unknown): string {
    if (result === undefined) return '';
    if (typeof result === 'string') return result;
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }

  function isTruncated(result: unknown): boolean {
    if (result === undefined) return false;
    if (typeof result === 'string') return result.length > 600;
    try {
      return JSON.stringify(result).length > 600;
    } catch {
      return false;
    }
  }

  function targetKeyOf(name: string, args: Record<string, unknown>): string {
    const rel = typeof args.relPath === 'string' ? args.relPath : '';
    if (name === 'write_chapter') return `${WRITE_KEY_PREFIX}${rel}`;
    if (name === 'delete_chapter') return `${DELETE_KEY_PREFIX}${rel}`;
    return EXPORT_KEY;
  }

  function openApproval(): void {
    const req = approval.pending.find((p) => p.callId === tool.id);
    if (req) approval.active = req;
  }

  async function reject(): Promise<void> {
    await chat.resolveApproval('reject', tool.id);
  }

  function stateColor(): string {
    switch (tool.state) {
      case 'running':
        return 'var(--status-polish)';
      case 'pending':
        return 'var(--status-draft)';
      case 'rejected':
        return 'var(--danger)';
      case 'done':
        return 'var(--ok)';
      default:
        return 'var(--muted)';
    }
  }
</script>

<div
  class="card"
  class:done={tool.state === 'done'}
  class:running={tool.state === 'running'}
  class:pending-approval={tool.state === 'pending'}
  class:rejected={tool.state === 'rejected'}
  class:open={effectiveOpen}
  class:locked={forceOpen !== undefined}
>
  <div
    class="head"
    role="button"
    tabindex="0"
    onclick={toggle}
    onkeydown={(e) => e.key === 'Enter' && toggle()}
  >
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style:transform={effectiveOpen ? 'none' : 'rotate(-90deg)'} style:color={stateColor()}><path d="M6 9l6 6 6-6"/></svg>
    <span class="tname">{tool.name}</span>
    <span class="targ">{argText}</span>
    {#if elapsedText}<span class="elapsed">{elapsedText}</span>{/if}
    <span class="state">
      {#if tool.state === 'running'}<i class="pulse-dot"></i>调用中
      {:else if tool.state === 'pending'}<i class="pulse-dot"></i>挂起待审批
      {:else if tool.state === 'rejected'}已拒绝
      {:else}✓{/if}
    </span>
  </div>

  {#if effectiveOpen}
    <div class="detail">
      <div class="kv"><span class="k">参 数</span><span class="v">{argText || '—'}</span></div>
      {#if shortResultText || showFull}
        <div class="kv">
          <span class="k">结 果</span>
          <span class="v">
            {#if showFull && fullResultText}
              <pre class="result-pre">{fullResultText}</pre>
              <button class="link" onclick={() => (showFull = false)}>收起</button>
            {:else if shortResultText}
              {shortResultText}
              {#if resultTruncated}<button class="link" onclick={() => (showFull = true)}>看全文</button>{/if}
            {/if}
          </span>
        </div>
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
  .elapsed {
    font-variant-numeric: tabular-nums;
    font-size: 10.5px;
    color: var(--muted);
    flex: none;
  }
  /* 外部强控展开/收起时禁用 hover 反馈以免误导 */
  .card.locked .head {
    cursor: default;
  }
  .card.locked .head:hover {
    background: transparent;
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
  /* 全文结果（D3）：pre 滚动区 + 等宽字体，2 空格缩进。 */
  .result-pre {
    display: block;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 6px 9px;
    margin: 0 0 4px;
    font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace;
    font-size: 11px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 240px;
    overflow: auto;
  }
  .link {
    font-size: 11px;
    color: var(--accent);
    padding: 0;
    margin-left: 6px;
    background: none;
    border: none;
    cursor: pointer;
    text-decoration: none;
  }
  .link:hover {
    text-decoration: underline;
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
