<script lang="ts">
  // AI 面板 v4：单栏切换 + 拖拽调宽（根治 P1 多栏叠加裁切）。
  // 单活动栏 activeCol，栏宽为运行时 ui.colWidth；栏左缘 5px 拖拽手柄（cursor: col-resize），
  // 复用 TreeView.svelte L117-258 已验证的 pointer 拖拽范式（setPointerCapture + window 监听），
  // 钳制到 [280, 可用宽]，拖拽中跳过宽度动效，松手恢复。
  import { iconSvg } from '../../lib/icons.js';
  import { chat } from '../../lib/chat.svelte.js';
  import { settings } from '../../lib/settings.svelte.js';
  import { ui, type AiColId } from '../../lib/ui.svelte.js';
  import SessionColumn from './SessionColumn.svelte';
  import ChatColumn from './ChatColumn.svelte';
  import ToolsColumn from './ToolsColumn.svelte';
  import ContextColumn from './ContextColumn.svelte';
  import SettingsColumn from './SettingsColumn.svelte';

  const COLS: { id: AiColId; title: string; hint: string }[] = [
    { id: 'session', title: '会话', hint: '挂载 / 会话(B7)' },
    { id: 'chat', title: '对话', hint: '消息流 / 输入' },
    { id: 'tools', title: '工具调用', hint: 'B3 就地审阅 · 点卡头展开/收起' },
    { id: 'context', title: '上下文', hint: '四维账本 · 伏笔/道具/时钟/知情' },
    { id: 'settings', title: '设置', hint: 'B6 / 外观 / 快照' },
  ];

  /** 当前活动栏条目（null = 收起只剩窄条）。 */
  const current = $derived(
    ui.activeCol ? COLS.find((c) => c.id === ui.activeCol) ?? null : null,
  );

  // ---------- 拖拽调宽（pointer 范式：参照 TreeView dragStart/dragMove/dragEnd） ----------
  let colEl: HTMLElement | undefined = $state();
  let resizing = $state(false);

  function startDrag(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.currentTarget as HTMLElement;
    // 捕获指针：拖出窗口 / 面板边界后松手也能收到 pointerup（jsdom / 某些 WebView2 不支持：忽略）
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // 事件仍走 window 监听，拖拽态可恢复
    }
    resizing = true;
    e.preventDefault();
  }
  function moveDrag(e: PointerEvent): void {
    if (!resizing) return;
    const rect = colEl?.getBoundingClientRect();
    if (!rect) return;
    // 拖拽左移=加宽：新宽 = 栏右缘 - 当前 X
    const next = rect.right - e.clientX;
    ui.setColWidth(next);
  }
  function endDrag(_e?: PointerEvent): void {
    if (!resizing) return;
    resizing = false;
  }
</script>

<aside class="ai" class:open={ui.aiOpen} class:resizing aria-label="AI 面板">
  {#if current}
    <section
      class="col"
      id={`col-${current.id}`}
      bind:this={colEl}
      aria-label={current.title}
    >
      <!-- 左缘 5px 拖拽热区（位于栏内 padding 空白处，不抢占内容点击） -->
      <div
        class="resize-handle"
        onpointerdown={startDrag}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调宽"
        tabindex="-1"
      ></div>
      <div class="head">
        <span class="title">{current.title}{#if current.id === 'tools'}<i class="n">{chat.messages.reduce((n, m) => n + (m.tools?.length ?? 0), 0)}</i>{/if}</span>
        <span class="hint">{current.hint}</span>
        <button
          class="icon-btn pin-btn"
          class:on={settings.aiPinned}
          onclick={() => settings.setAiPinned(!settings.aiPinned)}
          title={settings.aiPinned ? '取消钉住 AI 面板' : '钉住 AI 面板'}
          aria-label={settings.aiPinned ? '取消钉住 AI 面板' : '钉住 AI 面板'}
        >📌</button>
        <button class="icon-btn" onclick={() => ui.toggleCol(current.id)} title="关此栏（点窄条图标切换）" aria-label={`关闭${current.title}栏`}>
          {@html iconSvg('close', 14, 2)}
        </button>
      </div>
      <div class="body">
        {#if current.id === 'session'}
          <SessionColumn />
        {:else if current.id === 'chat'}
          <ChatColumn />
        {:else if current.id === 'tools'}
          <ToolsColumn />
        {:else if current.id === 'context'}
          <ContextColumn />
        {:else}
          <SettingsColumn />
        {/if}
      </div>
    </section>
  {/if}
</aside>

<svelte:window onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={endDrag} />

<style>
  .ai {
    width: 0;
    /* 固定高度面板：与窗口等高，列内 body 滚动，面板本身永不拉长 */
    height: 100%;
    /* 小窗口兜底：栏宽不挤压正文到不可用（钳制 + 列内 overflow 滚动，不再裁切） */
    max-width: calc(100vw - var(--tree-w) - var(--rail-w) - 160px);
    flex: none;
    display: flex;
    flex-direction: row;
    background: var(--panel);
    border-left: 1px solid transparent;
    overflow: hidden;
    transition: width var(--t-fold), border-left-color var(--t-fold);
  }
  .ai.open {
    width: var(--right-w);
    border-left-color: var(--line);
  }
  /* 拖拽期间跳过宽度过渡，松手再恢复 */
  .ai.resizing {
    transition: none;
  }
  .col {
    position: relative; /* resize-handle 绝对定位锚点 */
    flex: none;
    /* 宽填满 .ai 内容盒（.ai 含 1px 左边线）：栏宽唯一来源是 --right-w，
       栏不再自带宽度——否则 1px 边线会把栏挤出容器（P1 类裁切）。 */
    width: 100%;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--panel);
  }
  .resize-handle {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 5px; /* 4-6px 热区，落 5px */
    cursor: col-resize;
    z-index: 2;
    /* 透明热区：hover / 拖拽时由 ::after 画 1px 视觉线 */
    background: transparent;
    touch-action: none;
  }
  .resize-handle::after {
    content: '';
    position: absolute;
    left: 2px;
    top: 0;
    bottom: 0;
    width: 1px;
    background: transparent;
    transition: background var(--t-hover);
  }
  .resize-handle:hover::after,
  .ai.resizing .resize-handle::after {
    background: var(--accent);
  }
  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px 9px;
    border-bottom: 1px solid var(--line);
  }
  .title {
    font-size: 12.5px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .title .n {
    min-width: 17px;
    height: 17px;
    padding: 0 5px;
    border-radius: 9px;
    background: var(--accent);
    color: #fff;
    font-size: 10.5px;
    line-height: 17px;
    text-align: center;
  }
  .hint {
    flex: 1;
    font-size: 10.5px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .icon-btn {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 5px;
    color: var(--muted);
    transition: background var(--t-hover), color var(--t-hover);
    flex: none;
  }
  .icon-btn:hover {
    background: color-mix(in srgb, var(--muted) 12%, transparent);
    color: var(--ink);
  }
  .pin-btn.on {
    color: var(--accent);
  }
  .body {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
  }
</style>