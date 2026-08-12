<script lang="ts">
  // 组合根（v3）：启动连 core（Tauri core_info / 浏览器 query 参数），
  // 顶栏 + 结构树 + 中央（编辑器/暂存抽屉/选区浮层）+ AI 窄条 + 多栏面板；
  // 全局快捷键（Esc 收起、F8 专注、Ctrl+S 保存、Ctrl+J AI）、点击外部收起、窄条滚轮换栏、自动保存（设置间隔）。
  import { onMount } from 'svelte';
  import { connectCore } from './lib/core.js';
  import { work } from './lib/work.svelte.js';
  import { chat } from './lib/chat.svelte.js';
  import { candidates } from './lib/candidates.svelte.js';
  import { settings } from './lib/settings.svelte.js';
  import { snapshot } from './lib/snapshot.svelte.js';
  import { ui } from './lib/ui.svelte.js';
  import { mdToHtml } from './lib/markdown.js';
  import { approval } from './lib/approval.svelte.js';
  import Toolbar from './components/Toolbar.svelte';
  import TreeView from './components/tree/TreeView.svelte';
  import Editor from './components/editor/Editor.svelte';
  import StagingDrawer from './components/staging/StagingDrawer.svelte';
  import AiRail from './components/ai/AiRail.svelte';
  import AiPanel from './components/ai/AiPanel.svelte';
  import ApprovalCard from './components/approval/ApprovalCard.svelte';
  import SnapshotToast from './components/SnapshotToast.svelte';

  let booted = $state(false);
  let bootError = $state<string | null>(null);

  onMount(async () => {
    try {
      const { client, workDir } = await connectCore();
      work.init(client, workDir);
      chat.init(client);
      candidates.init(client);
      snapshot.init(client, workDir);
      await work.loadStructure();
      await chat.setScope(''); // 默认无归属讨论
      await candidates.load();
      booted = true;
    } catch (err) {
      bootError = err instanceof Error ? err.message : String(err);
    }
  });

  // 自动保存：间隔跟随设置（30/60/120s），有脏改动才落盘，失败走显式红条；saveCurrent 自带 saving 互斥
  $effect(() => {
    const sec = settings.autosaveSec;
    const timer = setInterval(() => {
      if (work.dirty) void work.saveCurrent();
    }, sec * 1000);
    return () => clearInterval(timer);
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      // 浮层/审批卡/面板逐级收起；审批卡 Esc 关闭后挂起卡仍在工具列可重新打开
      approval.active = null;
      ui.collapseAi();
    } else if (e.key === 'F8') {
      e.preventDefault();
      ui.toggleFocus();
      if (ui.focus) candidates.drawerOpen = false; // 专注=只剩编辑器,暂存抽屉一并收起
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void work.saveCurrent();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      ui.toggleAi();
    }
  }

  // v3：点击外部（正文/树/抽屉）收起 AI 面板；工具栏/窄条/面板/审批卡除外
  function onDocClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest('[data-ai-zone], #approval-overlay')) return;
    if (ui.aiOpen) ui.collapseAi();
  }

  // 窄条滚轮：任意位置增减栏数（内容区滚动不受影响）
  function onRailWheel(e: WheelEvent): void {
    e.preventDefault();
    ui.wheelAi(e.deltaY < 0 ? 1 : -1);
  }
</script>

<svelte:window onkeydown={onKeydown} onclick={onDocClick} />

{#if bootError}
  <div class="fatal">
    <p>连不上 core sidecar</p>
    <p class="detail">{bootError}</p>
  </div>
{:else if !booted}
  <div class="fatal"><p>正在连接 core sidecar…</p></div>
{:else}
  <div class="app" class:focus={ui.focus}>
    <Toolbar onSave={() => void work.saveCurrent()} />

    {#if work.error}
      <div class="bar error" role="alert">
        <span>{work.error}</span>
        <button onclick={() => work.dismissError()} aria-label="关闭">×</button>
      </div>
    {/if}
    {#if work.notice}
      <div class="bar notice" role="status">
        <span>{work.notice}</span>
        <button onclick={() => work.dismissNotice()} aria-label="关闭">×</button>
      </div>
    {/if}

    <div class="main">
      <aside class="left" data-ai-zone><TreeView /></aside>

      <section class="center">
        <div class="editor-area">
          {#if work.current}
            {#key work.current.relPath}
              <Editor
                html={mdToHtml(work.current.savedMd)}
                typewriter={settings.typewriter}
                scene={work.pendingScene}
              />
            {/key}
          {:else}
            <div class="placeholder">从左侧选择一章开始写作；Ctrl+S 保存，F8 专注。</div>
          {/if}
        </div>
        <StagingDrawer />
      </section>

      <div class="rail-wrap" data-ai-zone onwheel={onRailWheel}>
        <AiRail />
      </div>
      <div class="ai-wrap" data-ai-zone>
        <AiPanel />
      </div>
    </div>

    <ApprovalCard />
    <SnapshotToast />
  </div>
{/if}

<style>
  .fatal {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--muted);
  }
  .fatal .detail {
    color: var(--danger);
    font-size: 13px;
    max-width: 70ch;
  }
  .app {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 7px 14px;
    font-size: 13px;
    flex: none;
  }
  .bar.error {
    background: color-mix(in srgb, var(--danger) 12%, var(--paper));
    color: var(--danger);
    border-bottom: 1px solid var(--danger);
  }
  .bar.notice {
    background: color-mix(in srgb, var(--ok) 10%, var(--paper));
    color: var(--ok);
    border-bottom: 1px solid var(--ok);
  }
  .bar button {
    font-size: 15px;
    padding: 0 4px;
  }
  .main {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .left {
    width: var(--tree-w);
    flex: none;
    background: var(--panel);
    border-right: 1px solid var(--line);
    min-height: 0;
    overflow: hidden;
    transition: margin-left var(--t-fold);
  }
  .app.focus .left {
    margin-left: calc(-1 * var(--tree-w));
  }
  .center {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .editor-area {
    flex: 1;
    min-height: 0;
  }
  .rail-wrap {
    flex: none;
    overflow: hidden;
    transition: margin-right var(--t-fold);
  }
  .app.focus .rail-wrap {
    margin-right: calc(-1 * var(--rail-w));
  }
  .ai-wrap {
    flex: none;
    min-height: 0;
    transition: margin-right var(--t-fold);
  }
  .app.focus .ai-wrap {
    margin-right: calc(-1 * var(--right-w));
  }
  .placeholder {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-size: 14px;
  }
</style>
