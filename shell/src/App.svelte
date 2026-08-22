<script lang="ts">
  // 组合根（v3）：启动连 core（Tauri core_info / 浏览器 query 参数），
  // 顶栏 + 结构树 + 中央（编辑器/暂存抽屉/选区浮层）+ AI 窄条 + 多栏面板；
  // 全局快捷键（Esc 收起、F8 专注、Ctrl+S 保存、Ctrl+J AI）、点击外部收起、窄条滚轮换栏、自动保存（设置间隔）。
  import { onMount } from 'svelte';
  import { connectCore } from './lib/core.js';
  import { work } from './lib/work.svelte.js';
  import { chat } from './lib/chat.svelte.js';
  import { candidates } from './lib/candidates.svelte.js';
  import { quality } from './lib/quality.svelte.js';
  import { settings } from './lib/settings.svelte.js';
  import { snapshot } from './lib/snapshot.svelte.js';
  import { review } from './lib/review.svelte.js';
  import { scheme } from './lib/scheme.svelte.js';
  import { ui } from './lib/ui.svelte.js';
  import { mdToHtml } from './lib/markdown.js';
  import { approval } from './lib/approval.svelte.js';
  import { dialog } from './lib/dialog.svelte.js';
  import Toolbar from './components/Toolbar.svelte';
  import TreeView from './components/tree/TreeView.svelte';
  import NotesArea from './components/notes/NotesArea.svelte';
  import Editor from './components/editor/Editor.svelte';
  import StagingList from './components/staging/StagingList.svelte';
  import CandidateView from './components/staging/CandidateView.svelte';
  import StagingOverview from './components/staging/StagingOverview.svelte';
  import AiRail from './components/ai/AiRail.svelte';
  import AiPanel from './components/ai/AiPanel.svelte';
  import ApprovalCard from './components/approval/ApprovalCard.svelte';
  import SnapshotToast from './components/SnapshotToast.svelte';
  import ReviewPanel from './components/review/ReviewPanel.svelte';
  import DialogHost from './components/DialogHost.svelte';

  /** 协议契约版本（与 shell/src-tauri/src/lib.rs 的 EXPECTED_PROTOCOL 对齐，docs/decisions/0007）。触发式续写升 v4。 */
  const EXPECTED_PROTOCOL = 6;

  let booted = $state(false);
  let bootError = $state<string | null>(null);
  /** D5 键盘速查卡开合（? 或 Ctrl+/）。 */
  let helpOpen = $state(false);

  /** 连接 core 并初始化各 store + D2 握手 + 首屏数据加载；初次启动与 restart_core 后共用。 */
  async function connectAndBootCore(): Promise<void> {
    const { client, workDir } = await connectCore();
    work.init(client, workDir);
    chat.init(client);
    candidates.init(client);
    quality.init(client);
    snapshot.init(client, workDir);
    review.init(client, workDir);
    scheme.init(client); // work.init 已就位 workDir，load 直接按新作品拉 posture
    settings.init(client);
    void settings.loadLlmStatus();
    // 启动握手（D2，对齐 shell/src-tauri/src/lib.rs 的 validate_protocol）：
    // /v1/health 自报 protocol 字段，期望 v2，不匹配或缺字段直接红条拒接。
    const health = await client.health();
    if (typeof health.protocol === 'number' && health.protocol !== EXPECTED_PROTOCOL) {
      throw new Error(
        `core 协议版本不兼容：实际 v${health.protocol}，壳期望 v${EXPECTED_PROTOCOL}（见 docs/decisions/0007-协议契约-v1.md）`,
      );
    }
    if (health.protocol === undefined) {
      throw new Error('core 健康检查缺少 protocol 字段（core 版本过旧？）');
    }
    await work.loadStructure();
    await chat.setScope(''); // 默认无归属讨论
    await candidates.load();
    await scheme.load(); // 角色与方案（决策 0010）；失败静默降级为空态，不挡 boot/换书
  }

  onMount(async () => {
    // 重启 core 后的重连：restart_core 换新进程（新 port/token/workDir），重新连 + 重握手 + 重载数据
    settings.registerCoreRestartHandler(() => connectAndBootCore());
    try {
      await connectAndBootCore();
      booted = true;
    } catch (err) {
      bootError = err instanceof Error ? err.message : String(err);
    }
    void settings.loadAppConfig(); // 应用级配置（作品目录 + LLM）进 store，设置面板可改
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
    if (dialog.current) return; // 模态对话框打开时全局快捷键让位（Esc/Enter 由对话框消费）
    // D2.4：Esc 在输入态（textarea/input/contentEditable）只 blur，不收起 AI 面板——
    // 避免用户正在打字时被意外打断。
    const t = e.target;
    const inEditable =
      t instanceof HTMLElement &&
      (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
    // D5：?（非输入态）或 Ctrl+/ 开关键盘速查卡。
    if (((e.key === '?' || e.key === '？') && !inEditable) || ((e.ctrlKey || e.metaKey) && e.key === '/')) {
      e.preventDefault();
      helpOpen = !helpOpen;
      return;
    }
    if (e.key === 'Escape') {
      if (inEditable) {
        (t as HTMLElement).blur();
        return;
      }
      // 浮层/审批卡/面板逐级收起；审批卡 Esc 关闭后挂起卡仍在工具列可重新打开
      if (helpOpen) {
        helpOpen = false;
        return;
      }
      // 候选详情覆盖层打开时 Esc 归 CandidateView 处置（两个 window 监听都会触发,此处让路防连带收 AI 栏）
      if (candidates.viewingId || candidates.generating) return;
      approval.active = null;
      ui.collapseAi();
    } else if (e.key === 'F8') {
      e.preventDefault();
      ui.toggleFocus();
      if (ui.focus) candidates.viewingId = null; // 专注=只剩编辑器,关闭候选详情
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void work.saveCurrent();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      if (settings.continueEnabled && work.current && !candidates.continuing) {
        e.preventDefault();
        void candidates.continueFromChapter();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
      e.preventDefault();
      ui.toggleAi();
    }
  }

  // v3：点击外部（正文/树/抽屉）收起 AI 面板；工具栏/窄条/面板/审批卡除外
  function onDocClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    // 点击目标已被本次点击引发的 UI 变化卸载（如栏内「查看工具调用」跳栏后原栏卸载）：
    // 该点击发生在面板内,只是元素先走了,不能算"点外部"。
    if (!t.isConnected) return;
    if (t.closest('[data-ai-zone], #approval-overlay')) return;
    if (ui.aiOpen && !settings.aiPinned) ui.collapseAi();
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
      <aside class="left" data-ai-zone>
        <div class="staging-tabs"><button class:active={!candidates.stagingTab} onclick={() => (candidates.stagingTab = false)}>目录</button><button class:active={candidates.stagingTab} onclick={() => candidates.openStaging()}>暂存 {candidates.pendingCount}</button></div>
        <div class="left-tree">{#if candidates.stagingTab}<StagingList />{:else}<TreeView />{/if}</div>
        <NotesArea />
      </aside>

      <section class="center">
        <div class="editor-area">
          {#if work.current}
            {#key `${work.current.relPath}:${work.reloadNonce}`}
              <Editor
                html={mdToHtml(work.current.savedMd)}
                typewriter={settings.typewriter}
                scene={work.pendingScene}
                continueEnabled={settings.continueEnabled}
              />
            {/key}
          {:else}
            <div class="placeholder">从左侧选择一章开始写作；Ctrl+S 保存，F8 专注。</div>
          {/if}
          {#if candidates.viewingId || candidates.generating}<CandidateView />{/if}
        </div>
      </section>

      <div class="rail-wrap" data-ai-zone>
        <AiRail />
      </div>
      <div class="ai-wrap" data-ai-zone>
        <AiPanel />
      </div>
    </div>

    <ApprovalCard />
    {#if review.open}
      <ReviewPanel />
    {/if}
    {#if candidates.overviewOpen}
      <!-- 全览弹层挂顶层：openOverview 会关 stagingTab,挂 StagingList 内会随 tab 一起卸载 -->
      <StagingOverview />
    {/if}
    <SnapshotToast />
    <DialogHost />
    {#if helpOpen}
      <!-- D5 键盘速查卡：? / Ctrl+/ 开合，Esc/点遮罩关闭 -->
      <div class="help-mask" role="presentation" onmousedown={(e) => { if (e.target === e.currentTarget) helpOpen = false; }}>
        <div class="help-card" role="dialog" aria-modal="true" aria-label="键盘快捷键">
          <div class="help-title">键盘快捷键</div>
          <div class="help-row"><span class="key">Ctrl+S</span><span>保存当前章</span></div>
          <div class="help-row"><span class="key">Ctrl+J</span><span>开合 AI 面板</span></div>
          <div class="help-row"><span class="key">F8</span><span>专注模式（只留编辑器）</span></div>
          <div class="help-row"><span class="key">Esc</span><span>关闭浮层 / 收起面板（输入中只取消聚焦）</span></div>
          <div class="help-row"><span class="key">Enter</span><span>发送（对话输入框）</span></div>
          <div class="help-row"><span class="key">Shift+Enter</span><span>换行（对话输入框）</span></div>
          <div class="help-row"><span class="key">双击</span><span>重命名（会话名 / 卷章名）</span></div>
          <div class="help-row"><span class="key">? / Ctrl+/</span><span>本帮助</span></div>
        </div>
      </div>
    {/if}
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
  /* D5 键盘速查卡 */
  .help-mask {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.28);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 90;
  }
  .help-card {
    width: var(--overlay-modal, 480px);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: var(--shadow-pop);
    padding: 14px 16px 12px;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .help-title {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 2px;
  }
  .help-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 12px;
    color: var(--ink);
  }
  .help-row .key {
    flex: none;
    width: 86px;
    font-size: 11px;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 1px 6px;
    text-align: center;
    background: color-mix(in srgb, var(--muted) 8%, transparent);
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
    /* v5 左栏上下结构：上结构树（flex:1 自身滚动），下作者笔记（NotesArea 可拖拽调高） */
    display: flex;
    flex-direction: column;
  }
  .staging-tabs { display: flex; gap: 4px; padding: 8px 10px 6px; background: var(--panel); }
  .staging-tabs button { flex: 1; border: 0; border-radius: 999px; padding: 6px 4px; background: transparent; color: var(--muted); font-size: 11px; cursor: pointer; }
  .staging-tabs button.active { background: var(--paper); color: var(--ink); font-weight: 600; }
  /* 结构树占左栏剩余空间（min-height:0 + 自身滚动），笔记区 flex:none 由自身高度决定 */
  .left-tree {
    flex: 1;
    min-height: 0;
    overflow: hidden;
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
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .rail-wrap {
    flex: none;
    display: flex; /* 窄条随窗口等高拉伸 */
    min-height: 0;
    overflow: hidden;
    transition: margin-right var(--t-fold);
  }
  .app.focus .rail-wrap {
    margin-right: calc(-1 * var(--rail-w));
  }
  .ai-wrap {
    flex: none;
    /* 固定高度：与树/编辑器同列底（与窗口等高），内容超高栏内滚动，绝不让面板拉长 */
    height: 100%;
    min-height: 0;
    overflow: hidden;
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
