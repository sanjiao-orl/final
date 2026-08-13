<script lang="ts">
  // AI 面板 v3：按功能分栏——会话 / 对话 / 工具 / 设置。
  // 2 栏起可增至多栏，栏序固定，--right-w 由可见栏求和（App 按 ui 状态注入）；
  // 滚轮在面板非内容区（栏头/空白）增减栏数，内容区正常滚动。
  import { iconSvg } from '../../lib/icons.js';
  import { chat } from '../../lib/chat.svelte.js';
  import { aiColumns } from '../../theme.js';
  import { ui, type AiColId } from '../../lib/ui.svelte.js';
  import SessionColumn from './SessionColumn.svelte';
  import ChatColumn from './ChatColumn.svelte';
  import ToolsColumn from './ToolsColumn.svelte';
  import SettingsColumn from './SettingsColumn.svelte';

  function wheel(e: WheelEvent): void {
    // 内容区（栏体/输入框）正常滚动，栏头与空白区走栏数切换
    const t = e.target as HTMLElement;
    if (t.closest('.col-body, textarea, input, select')) return;
    e.preventDefault();
    ui.wheelAi(e.deltaY < 0 ? 1 : -1);
  }

  const COLS: { id: AiColId; title: string; hint: string }[] = [
    { id: 'session', title: '会话', hint: '挂载 / 会话(B7)' },
    { id: 'chat', title: '对话', hint: '消息流 / 输入' },
    { id: 'tools', title: '工具调用', hint: 'B3 就地审阅 · 点卡头展开/收起' },
    { id: 'settings', title: '设置', hint: 'B6 / 外观 / 快照' },
  ];
</script>

<aside class="ai" class:open={ui.aiOpen} onwheel={wheel} aria-label="AI 面板">
  {#each COLS as c (c.id)}
    {#if ui.cols.includes(c.id)}
      <section class="col" id={`col-${c.id}`} style:width={`${aiColumns.width[c.id]}px`} aria-label={c.title}>
        <div class="head">
          <span class="title">{c.title}{#if c.id === 'tools'}<i class="n">{chat.messages.reduce((n, m) => n + (m.tools?.length ?? 0), 0)}</i>{/if}</span>
          <span class="hint">{c.hint}</span>
          <button class="icon-btn" onclick={() => ui.toggleCol(c.id)} title="关此栏 (点窄条图标/滚轮可调)" aria-label={`关闭${c.title}栏`}>
            {@html iconSvg('close', 14, 2)}
          </button>
        </div>
        <div class="body">
          {#if c.id === 'session'}
            <SessionColumn />
          {:else if c.id === 'chat'}
            <ChatColumn />
          {:else if c.id === 'tools'}
            <ToolsColumn />
          {:else}
            <SettingsColumn />
          {/if}
        </div>
      </section>
    {/if}
  {/each}
</aside>

<style>
  .ai {
    width: 0;
    /* 固定高度面板：与窗口等高，列内 body 滚动，面板本身永不拉长 */
    height: 100%;
    /* 小窗口兜底：面板总宽不挤压正文到不可用（列内 overflow 裁切，仍可滚轮增减） */
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
  .col {
    flex: none;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border-right: 1px solid transparent;
  }
  .col:not(:last-child) {
    border-right-color: var(--line);
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
