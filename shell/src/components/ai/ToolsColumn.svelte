<script lang="ts">
  // 工具栏（D3 · v4）：按 assistant 轮次分组渲染；状态筛选 + 展开全部/收起全部；
  // 总卡片 >50 时分页（每页 50，无新增依赖，不虚拟滚动）。
  // ChatColumn 摘要跳转通过 chat.focusToolsGroupKey 命中分组 → 自动展开并滚到该组。
  import { chat } from '../../lib/chat.svelte.js';
  import ToolCard from './ToolCard.svelte';
  import type { ToolGroup } from '../../lib/chat.svelte.js';
  import type { ToolLine, ToolState } from '../../lib/chat.svelte.js';

  type Filter = 'all' | 'done' | 'failed' | 'pending';

  /** 筛选条件对单个 tool 的匹配；'pending' 同时包含 running（语义：进行中/审批中）。 */
  function matchFilter(t: ToolLine, f: Filter): boolean {
    if (f === 'all') return true;
    if (f === 'done') return t.state === 'done';
    if (f === 'failed') return t.state === 'rejected';
    // pending: 审批挂起 + 核心执行中（与方案"待审"对齐，含运行中）
    return t.state === 'pending' || t.state === 'running';
  }

  /** 全组命中筛选才显示整组，避免半空组观感割裂。 */
  function groupMatch(g: ToolGroup, f: Filter): boolean {
    return g.tools.some((t) => matchFilter(t, f));
  }

  /** 单组被 forceOpen 标记的判定：focus 命中 → 'open'；否则保持用户当前展开态。 */
  let expanded = $state<Set<string>>(new Set());
  /** 'all' = 全部展开，'none' = 全部收起，未设 = 用各卡内部默认。 */
  let expandMode = $state<'all' | 'none' | null>(null);

  function setExpand(mode: 'all' | 'none'): void {
    expandMode = mode;
    if (mode === 'all') {
      expanded = new Set(chat.toolGroups.map((g) => g.key));
    } else {
      expanded = new Set();
    }
  }

  function forceOpenOf(g: ToolGroup): 'open' | 'closed' | undefined {
    if (expandMode === 'all' || expanded.has(g.key)) return 'open';
    if (expandMode === 'none') return 'closed';
    return undefined;
  }

  let filter = $state<Filter>('all');
  /** 筛选后的分组（保持原顺序）；空筛选器时切回全量。 */
  const filtered = $derived(filter === 'all' ? chat.toolGroups : chat.toolGroups.filter((g) => groupMatch(g, filter)));
  /** 把筛选后的卡片摊平计数（用于分页与"展开全部/收起全部"集合）。 */
  const totalCards = $derived(filtered.reduce((n, g) => n + g.tools.length, 0));

  // ---- 分页：>100 卡片时每页 50，跨组切分（按工具数累计） ----
  const PAGE_SIZE = 50;
  const needPaging = $derived(totalCards > PAGE_SIZE);
  let currentPage = $state(1);
  $effect(() => {
    // 筛选切换 / 数据变化后重置到第 1 页（避免残留页码越界）
    void filter;
    void totalCards;
    currentPage = 1;
  });

  /** 把筛选后的全部分组按"累计卡片数"切到当前页；返回当前页可见的分组（每组含子集卡片）。 */
  const pageGroups = $derived.by(() => {
    if (!needPaging) return filtered.map((g) => ({ ...g, tools: g.tools }));
    const start = (currentPage - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const out: ToolGroup[] = [];
    let acc = 0;
    for (const g of filtered) {
      const next = acc + g.tools.length;
      if (next <= start) {
        acc = next;
        continue;
      }
      if (acc >= end) break;
      const sStart = Math.max(0, start - acc);
      const sEnd = Math.min(g.tools.length, end - acc);
      out.push({ ...g, tools: g.tools.slice(sStart, sEnd) });
      acc = next;
    }
    return out;
  });
  const totalPages = $derived(Math.max(1, Math.ceil(totalCards / PAGE_SIZE)));

  // ---- focus 定位：ChatColumn 摘要跳转触发 → 跳页 + 展开该组 + 滚到 ----
  let groupsEl = $state<HTMLDivElement | null>(null);
  /** 滚动锚：key → 元素引用。 */
  let groupRefs = $state<Record<string, HTMLDivElement | null>>({});

  $effect(() => {
    const key = chat.focusToolsGroupKey;
    if (!key) return;
    // 定位组在全量（filter 后）的索引
    const idx = filtered.findIndex((g) => g.key === key);
    if (idx === -1) {
      chat.focusToolsGroupKey = null; // 找不到（被筛选掉或已切存区），吞掉请求
      return;
    }
    // 跳到含该组的页
    if (needPaging) {
      let acc = 0;
      for (let i = 0; i < idx; i++) acc += filtered[i]!.tools.length;
      const page = Math.floor(acc / PAGE_SIZE) + 1;
      if (page !== currentPage) currentPage = page;
    }
    // 标记展开 + 滚动
    expanded = new Set([...expanded, key]);
    requestAnimationFrame(() => {
      const el = groupRefs[key];
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    chat.focusToolsGroupKey = null; // 消费完清掉，避免来回跳
  });

  // 筛选计数（用于顶部 tab 标注）
  const counts = $derived.by(() => {
    const c: Record<Filter, number> = { all: 0, done: 0, failed: 0, pending: 0 };
    for (const g of chat.toolGroups) {
      c.all += g.tools.length;
      for (const t of g.tools) {
        if (t.state === 'done') c.done++;
        if (t.state === 'rejected') c.failed++;
        if (t.state === 'pending' || t.state === 'running') c.pending++;
      }
    }
    return c;
  });

  const FILTERS: { id: Filter; label: string }[] = [
    { id: 'all', label: '全部' },
    { id: 'done', label: '成功' },
    { id: 'failed', label: '失败' },
    { id: 'pending', label: '待审' },
  ];

  function pageLabel(p: number): string {
    const start = (p - 1) * PAGE_SIZE + 1;
    const end = Math.min(p * PAGE_SIZE, totalCards);
    return `${start}–${end}`;
  }
</script>

<div class="head">
  <div class="tabs">
    {#each FILTERS as f (f.id)}
      <button
        class="tab"
        class:on={filter === f.id}
        onclick={() => (filter = f.id)}
        aria-pressed={filter === f.id}
      >{f.label}<i class="n">{counts[f.id]}</i></button>
    {/each}
  </div>
  <div class="ops">
    {#if totalCards > 0}
      <button class="btn sm" disabled={expandMode === 'all'} onclick={() => setExpand('all')} title="展开全部组内的卡">展开全部</button>
      <button class="btn sm" disabled={expandMode === 'none'} onclick={() => setExpand('none')} title="收起全部卡（不影响运行/挂起的自动展开，由各卡 forceOpen 控制）">收起全部</button>
    {/if}
  </div>
</div>

<div class="body" bind:this={groupsEl}>
  {#if chat.toolGroups.length === 0}
    <p class="hint">还没有工具调用。对 AI 下指令后，读章/搜索/统计等工具调用会以卡片列在这里，可点开就地审阅参数与结果（B3/B10）。例：「查一下账本」就会触发工具调用。</p>
  {:else if filtered.length === 0}
    <p class="hint">当前筛选下没有匹配的工具调用。</p>
  {:else}
    {#each pageGroups as g (g.key)}
      <div
        class="group"
        class:has-pending={g.hasPending}
        bind:this={groupRefs[g.key]}
      >
        <div class="group-head">
          {#if g.hasPending}<i class="pulse-dot"></i>{/if}
          <span class="gkey">轮 {Number(g.key) + 1}</span>
          <span class="gp">{g.userPrompt || '（无用户消息）'}</span>
          <span class="gn">{g.tools.length} 条</span>
        </div>
        {#each g.tools as t (t.id)}
          <ToolCard tool={t} forceOpen={forceOpenOf(g)} />
        {/each}
      </div>
    {/each}
  {/if}
</div>

{#if needPaging}
  <div class="pager" role="group" aria-label="分页">
    <button class="pg" disabled={currentPage <= 1} onclick={() => (currentPage = Math.max(1, currentPage - 1))}>上一页</button>
    <span class="pg-info">{pageLabel(currentPage)} / {totalCards} · 第 {currentPage} / {totalPages} 页</span>
    <button class="pg" disabled={currentPage >= totalPages} onclick={() => (currentPage = Math.min(totalPages, currentPage + 1))}>下一页</button>
  </div>
{/if}

<style>
  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 0 8px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 10px;
  }
  .tabs {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .tab {
    height: 22px;
    padding: 0 9px 0 10px;
    font-size: 11px;
    border-radius: 11px;
    border: 1px solid var(--line);
    color: var(--muted);
    background: transparent;
    transition: all var(--t-hover);
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .tab.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .tab:not(.on):hover {
    border-color: var(--accent-line);
    color: var(--accent);
  }
  .tab .n {
    font-variant-numeric: tabular-nums;
    font-size: 10.5px;
    background: color-mix(in srgb, var(--muted) 14%, transparent);
    border-radius: 7px;
    padding: 0 5px;
    min-width: 16px;
    line-height: 13px;
  }
  .tab.on .n {
    background: color-mix(in srgb, #fff 22%, transparent);
    color: #fff;
  }
  .ops {
    margin-left: auto;
    display: flex;
    gap: 4px;
  }
  .btn {
    height: 22px;
    padding: 0 8px;
    font-size: 11px;
    border-radius: 5px;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    transition: all var(--t-hover);
  }
  .btn:hover:not(:disabled) {
    border-color: var(--accent-line);
    color: var(--accent);
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .body {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
  }
  .hint {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.7;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 2px;
    font-size: 11px;
    color: var(--muted);
  }
  .group.has-pending .group-head {
    color: var(--ink);
  }
  .pulse-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--status-draft);
    animation: pulse 1.5s ease-in-out infinite;
    flex: none;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }
  .gkey {
    font-weight: 600;
    color: var(--ink);
    flex: none;
  }
  .gp {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-style: italic;
  }
  .gn {
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  .pager {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 8px 0 0;
    border-top: 1px solid var(--line);
    margin-top: 8px;
    font-size: 11px;
    color: var(--muted);
  }
  .pg {
    height: 22px;
    padding: 0 10px;
    font-size: 11px;
    border-radius: 5px;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--ink);
    cursor: pointer;
  }
  .pg:hover:not(:disabled) {
    border-color: var(--accent-line);
    color: var(--accent);
  }
  .pg:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .pg-info {
    font-variant-numeric: tabular-nums;
  }
</style>
