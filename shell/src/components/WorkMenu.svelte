<script lang="ts">
  // 作品菜单：顶栏作品名的下拉菜单（作品注册表列表 + 新建/打开现有目录入口）。
  // 纯展示组件：切换/新建/打开的动作回调由 Toolbar 侧实现（脏确认、选目录、重启 core）。
  import { settings } from '../lib/settings.svelte.js';
  import { work } from '../lib/work.svelte.js';

  interface Props {
    open: boolean;
    onClose: () => void;
    onPick: (dir: string) => void;
    onNew: () => void;
    onOpenExisting: () => void;
  }

  let { open, onClose, onPick, onNew, onOpenExisting }: Props = $props();

  /** 目录 basename 作品名（跨平台分隔符都切）。 */
  function nameOf(dir: string): string {
    return dir.split(/[\\/]/).filter(Boolean).pop() || dir;
  }
</script>

{#if open}
  <button class="work-menu-overlay" onclick={onClose} aria-label="关闭作品菜单"></button>
  <div class="work-menu" role="menu">
    <div class="work-menu-list">
      {#each settings.appWorks as dir}
        <button class="work-item" class:current={dir === work.workDir} title={dir} role="menuitem" onclick={() => onPick(dir)}>
          <span class="check">{dir === work.workDir ? '✓' : ''}</span>
          <span class="name">{nameOf(dir)}</span>
        </button>
      {:else}
        <div class="work-empty">还没有注册的作品</div>
      {/each}
    </div>
    <div class="work-menu-sep"></div>
    <button class="work-action" role="menuitem" onclick={onNew}>新建作品…</button>
    <button class="work-action" role="menuitem" onclick={onOpenExisting}>打开现有目录…</button>
    {#if settings.restarting}
      <div class="work-menu-status">正在切换…</div>
    {/if}
  </div>
{/if}

<style>
  .work-menu-overlay {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
    z-index: 40;
  }
  .work-menu {
    position: absolute;
    top: var(--toolbar-h);
    left: 6px;
    z-index: 41;
    min-width: 240px;
    max-width: 320px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    padding: 5px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .work-menu-list {
    max-height: 260px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .work-item,
  .work-action {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    height: 28px;
    padding: 0 8px;
    border-radius: 6px;
    font-size: 12.5px;
    color: var(--ink);
    text-align: left;
    cursor: pointer;
    transition: background var(--t-hover);
    white-space: nowrap;
    background: none;
    border: none;
  }
  .work-item:hover,
  .work-action:hover {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
  }
  .work-item .check {
    width: 14px;
    flex: none;
    color: var(--accent);
    font-weight: 700;
  }
  .work-item.current .name {
    color: var(--accent);
    font-weight: 600;
  }
  .work-item .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .work-menu-sep {
    height: 1px;
    background: var(--line);
    margin: 4px 6px;
    flex: none;
  }
  .work-menu-status {
    padding: 5px 8px 2px;
    font-size: 11px;
    color: var(--muted);
  }
  .work-empty {
    padding: 6px 8px;
    font-size: 11.5px;
    color: var(--muted);
  }
</style>
