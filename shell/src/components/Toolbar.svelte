<script lang="ts">
  // 顶栏 42px（v3）：作品名 / 当前章+脏点 / 保存/导出/快照 / 审批模式指示 / 暂存 / 打字机/明暗/专注/AI/设置。
  import { iconSvg } from '../lib/icons.js';
  import { candidates } from '../lib/candidates.svelte.js';
  import { settings } from '../lib/settings.svelte.js';
  import { snapshot } from '../lib/snapshot.svelte.js';
  import { dialog } from '../lib/dialog.svelte.js';
  import { review } from '../lib/review.svelte.js';
  import { ui } from '../lib/ui.svelte.js';
  import { work } from '../lib/work.svelte.js';

  interface Props {
    onSave: () => void;
  }
  let { onSave }: Props = $props();

  async function confirmDelete(): Promise<void> {
    const cur = work.current;
    if (!cur) return;
    const ok = await dialog.confirm({
      message: `删除「${cur.title}」？文件移入 .novel/trash/（软删，可找回）。`,
      okLabel: '删除',
      danger: true,
    });
    if (ok) void work.deleteChapter(cur.relPath);
  }

  /** 快照入口：列当前章快照，有则还原最新（B4）。 */
  async function openSnapshot(): Promise<void> {
    const cur = work.current;
    if (!cur) return;
    const list = await snapshot.listForChapter(cur.relPath);
    if (list.length === 0) {
      work.notice = '当前章还没有历史快照（保存覆写时自动滚动，最多 20 份）';
      return;
    }
    const name = list[0]?.path.split('/').pop() ?? '';
    const ok = await dialog.confirm({
      message: `还原到最新快照 ${name}？当前未保存改动会先保留在编辑器里。`,
      okLabel: '还原',
    });
    if (ok) void snapshot.restoreLatest(cur.relPath);
  }
</script>

<header data-ai-zone>
  <span class="tb-work" title={work.workDir}>{work.workName || '小说写作工作台'}</span>
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
  <button class="tb-btn" onclick={() => void openSnapshot()} disabled={!work.current} title="历史快照(B4)">
    {@html iconSvg('snapshot', 15)}
    快照
  </button>
  <button class="tb-btn danger" onclick={confirmDelete} disabled={!work.current} title="软删当前章进 .novel/trash/">
    删除
  </button>

  <span class="tb-spacer"></span>

  <button class="tb-mode" title="当前审批模式(B6) — 点击打开设置栏" onclick={() => ui.toggleCol('settings')}>
    <i class="dot"></i>{settings.approvalMode} 模式
  </button>
  <button class="tb-btn" class:on={review.open} disabled={review.running} onclick={() => void review.toggle()} title="审阅：全书去AI味扫描 + 账本确定性诊断（零 LLM 成本）；BLOCKER 未清零时徽标常显">
    {@html iconSvg('search', 15)}
    {review.running ? '扫描中…' : '审阅'}{#if review.blockerTotal > 0}<i class="tb-badge danger" title="BLOCKER 未清零">{review.blockerTotal}</i>{/if}
  </button>
  <button class="tb-btn" class:on={candidates.drawerOpen} onclick={() => candidates.toggleDrawer()} title="暂存区：AI 产出候选，批量采纳/整改/丢弃">
    {@html iconSvg('drawer', 15)}
    暂存{#if candidates.pendingCount > 0}<i class="tb-badge">{candidates.pendingCount}</i>{/if}
  </button>
  <button class="tb-btn" class:on={settings.typewriter} onclick={() => settings.setTypewriter(!settings.typewriter)} title="打字机滚动：光标锁 42%">
    {@html iconSvg('typewriter', 15)}
    打字机
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

<style>
  header {
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
</style>
