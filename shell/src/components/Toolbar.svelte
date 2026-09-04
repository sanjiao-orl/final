<script lang="ts">
  // 顶栏 42px（v3）：作品名（可切换作品）/ 当前章+脏点 / 保存/导出/快照 / 审批模式指示 / 暂存 / 光标锁/明暗/专注/AI/设置。
  import { open } from '@tauri-apps/plugin-dialog';
  import { tauriInvoke } from '../lib/core.js';
  import { iconSvg } from '../lib/icons.js';
  import { TRASH_DIR } from '../lib/paths.js';
  import { candidates } from '../lib/candidates.svelte.js';
  import { inbox } from '../lib/inbox.svelte.js';
  import { settings, APPROVAL_MODES, APPROVAL_MODE_LABELS, APPROVAL_MODE_DESCS, type ApprovalMode } from '../lib/settings.svelte.js';
  import { dialog } from '../lib/dialog.svelte.js';
  import { review } from '../lib/review.svelte.js';
  import { scheme } from '../lib/scheme.svelte.js';
  import { ui } from '../lib/ui.svelte.js';
  import { work } from '../lib/work.svelte.js';
  import {
    buildCalendarGrid,
    summarize,
    todayIso,
    type CalendarCell,
    type CalendarSummary,
    type DailyStat,
  } from '../lib/stats-calendar.js';
  import WorkMenu from './WorkMenu.svelte';
  import SnapshotBrowser from './SnapshotBrowser.svelte';

  interface Props {
    onSave: () => void;
  }
  let { onSave }: Props = $props();

  let menuOpen = $state(false);
  /** 仅桌面版（Tauri）支持作品切换；浏览器 dev 只给 title 提示。 */
  const tauriAvailable = tauriInvoke() !== undefined;

  /** 父目录：作品切换/新建时作为文件夹选择的 defaultPath。 */
  function parentPath(p: string): string | undefined {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return i > 0 ? p.slice(0, i) : undefined;
  }

  function toggleWorkMenu(): void {
    if (!tauriAvailable) return;
    menuOpen = !menuOpen;
  }

  /** 切换前脏确认：有未保存改动时提示，确认后才允许切换。 */
  async function confirmSwitch(): Promise<boolean> {
    if (!work.dirty) return true;
    return dialog.confirm({
      message: '未保存改动将丢失，确认切换？',
      okLabel: '切换',
      danger: true,
    });
  }

  /** 切换作品：脏改动先确认（未保存将丢失），再写配置 + 注册 works + 重启 core；切换中菜单保持打开显示状态行。 */
  async function switchTo(dir: string): Promise<void> {
    if (!dir || (dir === work.workDir && dir === settings.appWorkDir)) {
      menuOpen = false;
      return;
    }
    if (!(await confirmSwitch())) {
      menuOpen = false;
      return;
    }
    try {
      await settings.switchWork(dir);
    } finally {
      menuOpen = false;
    }
  }

  /** 新建作品：输名称 → 选父目录（默认当前作品上一级）→ create_work 建目录并注册切换。 */
  async function newWork(): Promise<void> {
    try {
      const name = await dialog.prompt({ message: '输入新作品名称（将在所选父目录下创建同名文件夹）', placeholder: '作品名称' });
      if (!name) return;
      const defaultPath = parentPath(work.workDir);
      const dir = await open({
        directory: true,
        title: '选择新建作品的父目录',
        ...(defaultPath ? { defaultPath } : {}),
      });
      if (typeof dir === 'string' && dir) {
        if (!(await confirmSwitch())) return;
        await settings.createWork(dir, name);
      }
    } catch {
      settings.appError = '选择文件夹失败（非 Tauri 环境？）';
    } finally {
      menuOpen = false;
    }
  }

  /** 打开现有目录：选目录 → 注册并切换。 */
  async function openExisting(): Promise<void> {
    try {
      const defaultPath = parentPath(work.workDir);
      const dir = await open({
        directory: true,
        title: '打开现有作品目录',
        ...(defaultPath ? { defaultPath } : {}),
      });
      if (typeof dir === 'string' && dir) await switchTo(dir);
    } catch {
      settings.appError = '选择文件夹失败（非 Tauri 环境？）';
    } finally {
      menuOpen = false;
    }
  }

  async function confirmDelete(): Promise<void> {
    const cur = work.current;
    if (!cur) return;
    const ok = await dialog.confirm({
      message: `删除「${cur.title}」？文件移入 ${TRASH_DIR}（软删，可找回）。`,
      okLabel: '删除',
      danger: true,
    });
    if (ok) void work.deleteChapter(cur.relPath);
  }

  /** 快照浏览器模态（D v5 替换原 dialog 确认逻辑）：打开快照列表 + 预览 + 还原。 */
  let snapshotBrowserOpen = $state(false);
  function openSnapshotBrowser(): void {
    if (!work.current) return;
    snapshotBrowserOpen = true;
  }
  function closeSnapshotBrowser(): void {
    snapshotBrowserOpen = false;
  }

  /** 方案下拉（决策 0010）：复刻 WorkMenu 的 overlay+menu 两件套，状态持有模式照 menuOpen。 */
  let schemeOpen = $state(false);
  function toggleSchemeMenu(): void {
    schemeOpen = !schemeOpen;
  }
  /** 选择方案：默认（null）清除激活；成功（含清除）后收起下拉。 */
  async function pickScheme(name: string | null): Promise<void> {
    const ok = await scheme.activate(name);
    if (ok) schemeOpen = false;
  }

  // ---------- 审批模式就地三选菜单（T14）：不再跳设置栏，复刻方案下拉的 overlay+menu 两件套 ----------
  let approvalOpen = $state(false);
  /** yolo 二次确认态：第一次点 yolo 只进入确认态，再点才真正生效；关菜单/选其他项即取消。 */
  let yoloConfirming = $state(false);

  function toggleApprovalMenu(): void {
    approvalOpen = !approvalOpen;
    yoloConfirming = false;
  }

  /** 选择审批模式：ask/auto 单击即生效并收起；yolo 走两段式确认。 */
  function pickApprovalMode(mode: ApprovalMode): void {
    if (mode === 'yolo' && !yoloConfirming) {
      yoloConfirming = true;
      return;
    }
    settings.setApproval(mode);
    approvalOpen = false;
    yoloConfirming = false;
  }

  // ---------- 码字日历（任务 1d：按日落账热力 + 速度摘要） ----------
  let calOpen = $state(false);
  let calLoading = $state(false);
  /** null = 拉取失败/无数据（弹层显示「暂无数据」，静默降级不报错）。 */
  let calDays = $state<DailyStat[] | null>(null);

  /** 开合日历下拉；打开时拉 getDailyStats（经 work store 代理 core client）。 */
  async function toggleCalendar(): Promise<void> {
    calOpen = !calOpen;
    if (!calOpen) return;
    calLoading = true;
    try {
      calDays = (await work.dailyStats()).days;
    } catch {
      calDays = null;
    } finally {
      calLoading = false;
    }
  }

  const calGrid = $derived(calDays ? buildCalendarGrid(calDays, todayIso()) : null);
  const calSummary = $derived(calDays ? summarize(calDays, todayIso()) : null);
  /** 网格是行主序（行=周一~周日）；CSS grid grid-auto-flow:column 按列填，这里转列主序扁平序列。 */
  const calCells = $derived.by((): CalendarCell[] => {
    const g = calGrid;
    if (!g) return [];
    const out: CalendarCell[] = [];
    for (let c = 0; c < 10; c++) for (let r = 0; r < 7; r++) out.push(g[r]![c]!);
    return out;
  });

  /** 格 tooltip：日期 + 当日增量（首日显总字数，未来/无记录直说）。 */
  function cellTip(cell: CalendarCell): string {
    if (cell.future) return `${cell.date} · 未来`;
    if (cell.words === undefined) return `${cell.date} · 无记录`;
    if (cell.delta === null || cell.delta === undefined) return `${cell.date} · 首日记录 ${cell.words.toLocaleString('zh-CN')} 字`;
    return `${cell.date} · ${cell.delta >= 0 ? '+' : ''}${cell.delta.toLocaleString('zh-CN')} 字`;
  }

  /** 摘要行首段：今日 +N；今日无记录 → 「今日 未记录」；今日是首个记录日 → 首日字数。 */
  function todayLabel(s: CalendarSummary): string {
    if (s.todayWords === null) return '今日 未记录';
    if (s.todayDelta === null) return `今日 首日 ${s.todayWords.toLocaleString('zh-CN')} 字`;
    return `今日 ${s.todayDelta >= 0 ? '+' : ''}${s.todayDelta.toLocaleString('zh-CN')}`;
  }
</script>

<header data-ai-zone>
  <button
    class="tb-work"
    onclick={toggleWorkMenu}
    title={tauriAvailable ? work.workDir : '作品切换仅桌面版可用'}
  >
    {work.workName || '小说写作工作台'}
  </button>
  <WorkMenu
    open={menuOpen}
    onClose={() => (menuOpen = false)}
    onPick={(dir) => void switchTo(dir)}
    onNew={() => void newWork()}
    onOpenExisting={() => void openExisting()}
  />
  <span class="tb-sep"></span>
  <span class="tb-chapter" title={work.current ? work.current.title : '未打开章节'}>
    {work.current ? work.current.title : '未打开章节'}
    {#if work.dirty}<i class="tb-dirty" title="未保存"></i>{/if}
    {#if work.saving}<span class="saving">保存中…</span>{/if}
  </span>
  <span class="tb-sep"></span>

  <button class="tb-btn" onclick={onSave} disabled={!work.current || work.saving} title="保存 (Ctrl+S)">
    {@html iconSvg('save', 15)}
    保存
  </button>
  <button class="tb-btn" onclick={() => void work.exportAll()} title="全稿导出 txt 到作品文件夹根">
    {@html iconSvg('export', 15)}
    导出
  </button>
  <button class="tb-btn" onclick={openSnapshotBrowser} disabled={!work.current} title="历史快照：浏览/预览/还原">
    {@html iconSvg('snapshot', 15)}
    快照
  </button>
  <button class="tb-btn danger" onclick={confirmDelete} disabled={!work.current} title={`软删当前章进 ${TRASH_DIR}`}>
    删除
  </button>

  <span class="tb-spacer"></span>

  <span class="tb-mode-anchor">
    <button
      class="tb-mode"
      class:on={approvalOpen}
      onclick={toggleApprovalMenu}
      title={`当前审批模式：${settings.approvalMode} — ${APPROVAL_MODE_LABELS[settings.approvalMode]}，点击切换`}
    >
      <i class="dot"></i>审批·{APPROVAL_MODE_LABELS[settings.approvalMode]}
    </button>
    {#if approvalOpen}
      <!-- T14 审批模式下拉：同款 overlay+menu 两件套；yolo 项两段式确认，选其他项或关 overlay 即取消 -->
      <button class="approval-menu-overlay" onclick={toggleApprovalMenu} aria-label="关闭审批模式菜单"></button>
      <div class="approval-menu" role="menu" aria-label="审批模式">
        {#each APPROVAL_MODES as m (m)}
          <button
            class="approval-item"
            class:confirm={m === 'yolo' && yoloConfirming}
            role="menuitem"
            onclick={() => pickApprovalMode(m)}
          >
            <span class="check">{settings.approvalMode === m ? '✓' : ''}</span>
            <span class="body">
              <span class="name">
                {#if m === 'yolo' && yoloConfirming}确认开启全部放行？写/删/导出将不再询问{:else}{APPROVAL_MODE_LABELS[m]}{/if}
              </span>
              <span class="desc">{m === 'yolo' && yoloConfirming ? '再次点击确认；点其他项取消' : APPROVAL_MODE_DESCS[m]}</span>
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </span>
  <span class="tb-scheme-anchor">
    <button class="tb-mode" class:on={schemeOpen} onclick={toggleSchemeMenu} title="角色与方案(0010) — 三通道（chat/rewrite/review）请求携带当前方案的 persona">
      <i class="dot"></i>方案：{scheme.activeScheme ?? '默认'}
    </button>
    {#if schemeOpen}
      <!-- 决策 0010 方案下拉：复刻 WorkMenu 的 overlay+menu 两件套（样式同款，含义另注） -->
      <button class="scheme-menu-overlay" onclick={() => (schemeOpen = false)} aria-label="关闭方案菜单"></button>
      <div class="scheme-menu" role="menu">
        <button class="work-item" class:current={scheme.activeScheme === null} role="menuitem" onclick={() => void pickScheme(null)}>
          <span class="check">{scheme.activeScheme === null ? '✓' : ''}</span>
          <span class="name">默认</span>
        </button>
        {#each scheme.schemes as s}
          <button class="work-item" class:current={scheme.activeScheme === s.name} role="menuitem" onclick={() => void pickScheme(s.name)}>
            <span class="check">{scheme.activeScheme === s.name ? '✓' : ''}</span>
            <span class="name">{s.name}</span>
          </button>
        {:else}
          <div class="work-empty">还没有方案（可在作品 .novel/schemes/ 下新增）</div>
        {/each}
      </div>
    {/if}
  </span>
  <span class="tb-cal-anchor">
    <button class="tb-mode" class:on={calOpen} onclick={() => void toggleCalendar()} title="码字日历：按日落账，近 10 周热力 + 速度摘要">
      <i class="dot"></i>日历
    </button>
    {#if calOpen}
      <!-- 码字日历下拉：同款 overlay+menu 两件套；热力格 11px，5 档色阶由 --ok/--muted 派生（深浅主题通吃） -->
      <button class="cal-menu-overlay" onclick={() => (calOpen = false)} aria-label="关闭码字日历"></button>
      <div class="cal-menu" role="menu" aria-label="码字日历">
        {#if calLoading}
          <div class="cal-empty">加载中…</div>
        {:else if calSummary}
          <div class="cal-grid" role="img" aria-label="近 10 周码字热力图">
            {#each calCells as cell (cell.date)}
              <span class="cal-cell lv{cell.level}" class:future={cell.future} title={cellTip(cell)}></span>
            {/each}
          </div>
          <div class="cal-summary">
            <span>{todayLabel(calSummary)}</span>
            <span>近7日均 {calSummary.weekAvg.toLocaleString('zh-CN')}</span>
            <span>记录 {calSummary.totalDays} 天</span>
            <span>总字数 {calSummary.totalWords.toLocaleString('zh-CN')}</span>
          </div>
        {:else}
          <div class="cal-empty">暂无数据</div>
        {/if}
      </div>
    {/if}
  </span>
  <button
    class="tb-btn"
    class:on={review.open}
    onclick={() => void review.toggle()}
    title={review.running
      ? '审阅正在后台进行：点击查看进度或取消；完成后结果保留'
      : '审阅：全书去AI味扫描 + 账本确定性诊断（零 LLM 成本）；拦路（BLOCKER）未清零时徽标常显'}
  >
    {@html iconSvg('search', 15)}
    {review.running ? (review.open ? '扫描中…' : '后台扫描中…') : '审阅'}{#if review.blockerTotal > 0}<i class="tb-badge danger" title="拦路（BLOCKER）未清零">{review.blockerTotal}</i>{/if}
  </button>
  <button class="tb-btn" class:on={candidates.stagingTab} onclick={() => candidates.openStaging()} title="暂存区：AI 产出候选，批量采纳/整改/丢弃">
    {@html iconSvg('drawer', 15)}
    暂存{#if candidates.pendingCount > 0}<i class="tb-badge">{candidates.pendingCount}</i>{/if}
  </button>
  <button class="tb-btn" class:on={inbox.tabOpen} onclick={() => { candidates.stagingTab = false; inbox.openTab(); }} title="裁决收件箱：补账扫描的承诺伏笔提案待裁决（作者裁决后才落账）">
    {@html iconSvg('drawer', 15)}
    收件箱{#if inbox.pendingCount > 0}<i class="tb-badge">{inbox.pendingCount}</i>{/if}
  </button>
  <button class="tb-btn" class:on={settings.typewriter} onclick={() => settings.setTypewriter(!settings.typewriter)} title="光标锁：光标行锁定屏幕 42% 处，长文输入不追底">
    {@html iconSvg('typewriter', 15)}
    光标锁
  </button>
  <button class="tb-btn" onclick={() => settings.toggleMode()} title="明暗切换" aria-label="明暗切换">
    {@html iconSvg('moon', 15)}
  </button>
  <button class="tb-btn" class:on={ui.focus} onclick={() => ui.toggleFocus()} title="专注 (F8)">
    {@html iconSvg('focus', 15)}
  </button>
  <button class="tb-btn" class:on={ui.aiOpen} onclick={() => ui.toggleAi()} title="AI 面板 (Ctrl+J)">
    {@html iconSvg('spark', 15)}
    AI
  </button>
  <button class="tb-btn" class:on={ui.isOpen('settings')} onclick={() => ui.toggleCol('settings')} title="设置">
    {@html iconSvg('settings', 15)}
  </button>
</header>
<SnapshotBrowser open={snapshotBrowserOpen} onClose={closeSnapshotBrowser} />

<style>
  header {
    position: relative;
    height: var(--toolbar-h);
    flex: none;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 10px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    user-select: none;
    z-index: 30;
  }
  .tb-work {
    font-family: var(--body-font);
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.06em;
    padding: 0 8px 0 4px;
    white-space: nowrap;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    background: none;
    border: none;
    color: var(--ink);
    cursor: pointer;
    border-radius: 6px;
    transition: background var(--t-hover);
  }
  .tb-work:hover {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
  }
  .tb-chapter {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--muted);
    padding: 3px 8px;
    border-radius: 5px;
    max-width: 240px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: background var(--t-hover);
  }
  .tb-chapter:hover {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
  }
  .tb-dirty {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--status-draft);
    flex: none;
  }
  .saving {
    color: var(--muted);
    font-size: 11px;
  }
  .tb-sep {
    width: 1px;
    height: 18px;
    background: var(--line);
    margin: 0 6px;
    flex: none;
  }
  .tb-spacer {
    flex: 1;
  }
  .tb-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 9px;
    font-size: 12.5px;
    color: var(--ink);
    border-radius: 6px;
    transition: background var(--t-hover);
    white-space: nowrap;
  }
  .tb-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
  }
  .tb-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tb-btn.on {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .tb-btn.danger:hover:not(:disabled) {
    color: var(--danger);
  }
  .tb-btn :global(svg) {
    width: 15px;
    height: 15px;
    flex: none;
  }
  .tb-badge {
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    font-size: 10.5px;
    line-height: 16px;
    text-align: center;
  }
  .tb-badge.danger {
    background: var(--danger);
  }
  .tb-mode {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    padding: 0 8px;
    margin-right: 2px;
    border: 1px solid var(--line);
    border-radius: 11px;
    font-size: 11px;
    color: var(--muted);
    transition: border-color var(--t-hover), color var(--t-hover);
  }
  .tb-mode:hover {
    border-color: var(--accent-line);
    color: var(--accent);
  }
  .tb-mode .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--status-draft);
  }
  .tb-mode.on {
    border-color: var(--accent-line);
    color: var(--accent);
  }
  /* T14 审批模式下拉：包裹 pill 锚定，几何同款方案/日历下拉（样式名独立，避免与 scheme-menu 撞） */
  .tb-mode-anchor {
    position: relative;
    display: inline-flex;
    align-items: center;
    height: 100%;
    flex: none;
  }
  .approval-menu-overlay {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
    z-index: 40;
  }
  .approval-menu {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 41;
    min-width: 260px;
    max-width: 320px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: var(--shadow-pop);
    padding: 5px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  /* 菜单项：主行中文标签 + 一行小字说明；yolo 确认态整条转 danger 色 */
  .approval-item {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 5px 8px;
    border-radius: 6px;
    font-size: 12px;
    color: var(--ink);
    text-align: left;
    cursor: pointer;
    transition: background var(--t-hover);
    background: none;
    border: none;
  }
  .approval-item:hover {
    background: color-mix(in srgb, var(--muted) 10%, transparent);
  }
  .approval-item .check {
    width: 14px;
    flex: none;
    color: var(--accent);
    font-weight: 700;
  }
  .approval-item .name {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .approval-item .desc {
    display: block;
    margin-top: 1px;
    font-size: 10.5px;
    line-height: 1.5;
    color: var(--muted);
    white-space: normal;
  }
  .approval-item.confirm .name {
    color: var(--danger);
    font-weight: 600;
  }
  .approval-item.confirm .desc,
  .approval-item.confirm .check {
    color: var(--danger);
  }
  /* 决策 0010 方案下拉：包裹 pill 锚定（撑满 header 高度 → top:100% 即落到 header 下方，right:0 对齐 pill 右缘） */
  .tb-scheme-anchor {
    position: relative;
    display: inline-flex;
    align-items: center;
    height: 100%;
    flex: none;
  }
  .scheme-menu-overlay {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
    z-index: 40;
  }
  .scheme-menu {
    position: absolute;
    top: 100%;
    right: 0;
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
  .work-item {
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
  .work-item:hover {
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
  .work-empty {
    padding: 6px 8px;
    font-size: 11.5px;
    color: var(--muted);
  }
  /* 码字日历下拉（任务 1d）：包裹 pill 锚定，几何同款方案下拉 */
  .tb-cal-anchor {
    position: relative;
    display: inline-flex;
    align-items: center;
    height: 100%;
    flex: none;
  }
  .cal-menu-overlay {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    padding: 0;
    cursor: default;
    z-index: 40;
  }
  .cal-menu {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 41;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: var(--shadow-pop);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  /* 热力网格：行=周一~周日 7 行，grid-auto-flow:column 让 10 周按列排（格 11px，规格 10-12px 内） */
  .cal-grid {
    display: grid;
    grid-template-rows: repeat(7, 11px);
    grid-auto-flow: column;
    gap: 2px;
  }
  .cal-cell {
    width: 11px;
    height: 11px;
    border-radius: 2px;
    /* lv0 无记录：muted 弱底（深浅主题均从 token 派生） */
    background: color-mix(in srgb, var(--muted) 14%, transparent);
  }
  /* lv1-lv4：--ok 四档递进（有字 → 4000+ 满档），混 --panel 保证深浅主题底温一致 */
  .cal-cell.lv1 {
    background: color-mix(in srgb, var(--ok) 30%, var(--panel));
  }
  .cal-cell.lv2 {
    background: color-mix(in srgb, var(--ok) 50%, var(--panel));
  }
  .cal-cell.lv3 {
    background: color-mix(in srgb, var(--ok) 72%, var(--panel));
  }
  .cal-cell.lv4 {
    background: var(--ok);
  }
  .cal-cell.future {
    opacity: 0.35;
  }
  .cal-summary {
    display: flex;
    gap: 10px;
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .cal-empty {
    padding: 10px 12px;
    font-size: 11.5px;
    color: var(--muted);
    white-space: nowrap;
  }
</style>
