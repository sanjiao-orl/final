<script lang="ts">
  // 组合根：启动连 core（Tauri core_info / 浏览器 query 参数），三栏布局，全局快捷键。
  import { onMount } from 'svelte';
  import { connectCore } from './lib/core.js';
  import { work } from './lib/work.svelte.js';
  import { chat } from './lib/chat.svelte.js';
  import { candidates } from './lib/candidates.svelte.js';
  import { ui } from './lib/ui.svelte.js';
  import { mdToHtml } from './lib/markdown.js';
  import Toolbar from './components/Toolbar.svelte';
  import TreeView from './components/TreeView.svelte';
  import Editor from './components/Editor.svelte';
  import AiPanel from './components/AiPanel.svelte';
  import StagingDrawer from './components/StagingDrawer.svelte';

  let booted = $state(false);
  let bootError = $state<string | null>(null);

  onMount(async () => {
    try {
      const { client, workDir } = await connectCore();
      work.init(client, workDir);
      chat.init(client);
      candidates.init(client);
      await work.loadStructure();
      await chat.setScope(''); // 默认无归属讨论存区
      await candidates.load();
      booted = true;
    } catch (err) {
      bootError = err instanceof Error ? err.message : String(err);
    }
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'F8') {
      e.preventDefault();
      ui.toggleFocus();
      if (ui.focus) candidates.drawerOpen = false; // 专注=只剩编辑器,暂存抽屉一并收起
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void work.saveCurrent();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      ui.toggleRight();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if bootError}
  <div class="fatal">
    <p>连不上 core sidecar</p>
    <p class="detail">{bootError}</p>
  </div>
{:else if !booted}
  <div class="fatal"><p>正在连接 core sidecar…</p></div>
{:else}
  <div class="app">
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

    <main>
      {#if !ui.focus}
        <aside class="left"><TreeView /></aside>
      {/if}
      <section class="center">
        <div class="editor-area">
          {#if work.current}
            {#key work.current.relPath}
              <Editor
                html={mdToHtml(work.current.savedMd)}
                typewriter={ui.typewriter}
                scene={work.pendingScene}
              />
            {/key}
          {:else}
            <div class="placeholder">从左侧选择一章开始写作；Ctrl+S 保存，F8 专注。</div>
          {/if}
        </div>
        <StagingDrawer />
      </section>
      {#if !ui.focus && ui.rightOpen}
        <aside class="right"><AiPanel /></aside>
      {/if}
    </main>
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
  main {
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
  .right {
    width: var(--right-w);
    flex: none;
    border-left: 1px solid var(--line);
    min-height: 0;
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
