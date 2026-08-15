<script lang="ts">
  // AI 窄条 48px（v4）：默认收起形态，点图标切换单活动栏（同栏再点=收起），hover 左侧弹出提示。
  // 滚轮增减栏手势已删除（与单栏切换冲突；栏宽由 AiPanel 左缘拖拽手柄调）。
  import { iconSvg } from '../../lib/icons.js';
  import { ui, type AiColId } from '../../lib/ui.svelte.js';

  const VIEWS: { id: AiColId; label: string; tip: string }[] = [
    { id: 'session', label: '会话', tip: '会话 · 挂载 / 会话列表(B7)' },
    { id: 'chat', label: '对话', tip: '对话 · 消息流 / 输入' },
    { id: 'tools', label: '工具', tip: '工具 · 调用卡(B3/B10)' },
  ];
</script>

<aside class="rail" aria-label="AI 面板窄条">
  <span class="logo" title="AI 面板 · 默认收起；点图标切换活动栏">{@html iconSvg('spark', 18)}</span>
  {#each VIEWS as v (v.id)}
    <button
      class="btn"
      class:on={ui.isOpen(v.id)}
      onclick={() => ui.toggleCol(v.id)}
      title={v.tip}
      aria-label={v.tip}
    >
      {@html iconSvg(v.id === 'session' ? 'session' : v.id === 'chat' ? 'chat' : 'tools', 18)}
      <span class="tip">{v.tip}</span>
    </button>
  {/each}
  <span class="spacer"></span>
  <button class="btn" class:on={ui.isOpen('settings')} onclick={() => ui.toggleCol('settings')} title="设置" aria-label="设置">
    {@html iconSvg('settings', 18)}
    <span class="tip">设置</span>
  </button>
</aside>

<style>
  .rail {
    width: var(--rail-w);
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    padding: 10px 0 12px;
    background: var(--panel);
    border-left: 1px solid var(--line);
    user-select: none;
    transition: margin-right var(--t-fold);
  }
  .logo {
    width: 34px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    margin-bottom: 8px;
  }
  .btn {
    position: relative;
    width: 36px;
    height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    color: var(--muted);
    transition: background var(--t-hover), color var(--t-hover);
  }
  .btn:hover {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
    color: var(--ink);
  }
  .btn.on {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .tip {
    position: absolute;
    left: calc(100% + 10px);
    top: 50%;
    transform: translateY(-50%) translateX(-3px);
    background: var(--ink);
    color: var(--paper);
    font-size: 11px;
    line-height: 1;
    letter-spacing: 0.04em;
    padding: 7px 10px;
    border-radius: 6px;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--t-hover), transform var(--t-hover);
    z-index: 120;
    box-shadow: var(--shadow-pop);
  }
  .btn:hover .tip {
    opacity: 1;
    transform: translateY(-50%) translateX(0);
  }
  .spacer {
    flex: 1;
  }
</style>
