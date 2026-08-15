<script lang="ts">
  // 上下文栏（v5 新增，D3 五栏之一）：四维账本只读视图 —— 伏笔 / 道具 / 时钟 / 知情。
  // 数据来源 snapshot.loadLedger（.novel/ledger.md，避硬塞 ledger_upsert）；空态给引导文案。
  // 行高紧凑（查阅面板不是编辑器）；刷新 = 手动按钮 + 开栏自动取数；最近刷新时间小字。
  import { onMount } from 'svelte';
  import { iconSvg } from '../../lib/icons.js';
  import { snapshot, type LedgerView } from '../../lib/snapshot.svelte.js';

  type LoadState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; ledger: LedgerView; at: string }
    | { kind: 'error'; message: string };

  let state = $state<LoadState>({ kind: 'idle' });

  /** 短刷：仅 re-fetch，不重 mount 副作用。 */
  async function refresh(): Promise<void> {
    state = { kind: 'loading' };
    try {
      const r = await snapshot.loadLedger();
      const at = new Date();
      const stamp = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}`;
      state = { kind: 'ready', ledger: r.ledger, at: stamp };
    } catch (err) {
      state = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  onMount(() => {
    void refresh();
  });

  const ledger = $derived(state.kind === 'ready' ? state.ledger : null);
  const promisesCount = $derived(ledger?.promises.length ?? 0);
  const propsCount = $derived(ledger?.props.length ?? 0);
  const clockCount = $derived(ledger?.clock.length ?? 0);
  const knowledgeCount = $derived(ledger?.knowledge.length ?? 0);
  const totalEntries = $derived(promisesCount + propsCount + clockCount + knowledgeCount);

  // ---------- 行渲染用的紧凑字符串 ----------

  /** 提取章 relPath 中的"卷/第N章"尾巴，避免显示整段 manuscript/卷一/第一章·少年.md */
  function chapterShort(rel: string): string {
    const base = rel.split('/').pop() ?? rel;
    return base.replace(/\.md$/i, '');
  }

  /** 道具当前持有/状态（取最新一条 custody 与 prop.status 兜底）。 */
  function propLine(p: LedgerView['props'][number]): string {
    const parts: string[] = [];
    if (p.type) parts.push(p.type);
    if (p.holder) parts.push(`现持:${p.holder}`);
    else {
      const last = p.custody[p.custody.length - 1];
      if (last?.holder) parts.push(`现持:${last.holder}`);
    }
    if (p.status) parts.push(p.status);
    return parts.length ? ` · ${parts.join(' · ')}` : '';
  }

  /** 时钟行：尽量堆故事日 + 季节，缺则回 chapters。 */
  function clockLine(c: LedgerView['clock'][number]): string {
    const tags: string[] = [];
    if (c.storyDay) tags.push(c.storyDay);
    if (c.season && c.season !== '未锚定') tags.push(c.season);
    if (c.absoluteDate) tags.push(c.absoluteDate);
    const head = tags.length ? tags.join(' · ') : c.chapters.map(chapterShort).join(' · ');
    return c.notes ? ` · ${c.notes}` : head;
  }

  /** 知情行：visibility 标签 + 已知事实首条 + 总条数。 */
  function knowledgeLine(k: LedgerView['knowledge'][number]): string {
    const tag = k.visibility && k.visibility !== 'public' ? `[${k.visibility}] ` : '';
    const first = k.knows[0] ?? '(空)';
    const more = k.knows.length > 1 ? ` · +${k.knows.length - 1}` : '';
    return k.character ? `${tag}${first}${more}` : first;
  }

  /** 伏笔 setup/payoff 计数 + 最新 setup 章（无则空）。 */
  function promiseMeta(p: LedgerView['promises'][number]): string {
    const setupLast = p.setups[p.setups.length - 1];
    const payoffLast = p.payoffs[p.payoffs.length - 1];
    const arc = p.arc ? `[${p.arc}]` : '';
    const heat = p.heat ? ` ${p.heat}` : '';
    const head = `${arc}${heat}`.trim();
    const tail =
      `${p.setups.length}埋/${p.payoffs.length}收` +
      (setupLast ? ` · 起 ${chapterShort(setupLast.chapter)}` : '') +
      (payoffLast ? ` · 收 ${chapterShort(payoffLast.chapter)}` : '');
    const note = p.note ? ` · ${p.note}` : '';
    return head ? `${head} · ${tail}${note}` : `${tail}${note}`;
  }
</script>

<div class="ctx">
  <div class="head">
    <span class="title">四维账本</span>
    <span class="hint">{totalEntries > 0 ? `共 ${totalEntries} 条` : '空账本'}</span>
    <button class="refresh" onclick={() => void refresh()} title="刷新账本" aria-label="刷新账本">
      {@html iconSvg('refresh', 13)}
    </button>
  </div>

  {#if state.kind === 'ready' && state.at}
    <span class="stamp">已刷新 {state.at}</span>
  {/if}

  {#if state.kind === 'loading'}
    <div class="status">加载账本中…</div>
  {:else if state.kind === 'error'}
    <div class="status err">加载失败：{state.message}</div>
  {:else if !ledger}
    <div class="status">尚未取数</div>
  {:else}
    <!-- 伏笔 -->
    <section class="zone">
      <header class="zone-head">
        <span class="zone-title">伏笔</span>
        <span class="zone-count">{promisesCount}</span>
      </header>
      {#if promisesCount === 0}
        <p class="empty">还没有伏笔账本，对 AI 说「建伏笔账本」即可创建。</p>
      {:else}
        <ul class="rows">
          {#each ledger.promises as p (p.id)}
            <li class="row">
              <span class="row-name">{p.name}</span>
              <span class="row-meta">{promiseMeta(p)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- 道具 -->
    <section class="zone">
      <header class="zone-head">
        <span class="zone-title">道具</span>
        <span class="zone-count">{propsCount}</span>
      </header>
      {#if propsCount === 0}
        <p class="empty">还没有道具账本条目，对 AI 说「记一件道具」即可登记。</p>
      {:else}
        <ul class="rows">
          {#each ledger.props as p (p.name)}
            <li class="row">
              <span class="row-name">{p.name}</span>
              <span class="row-meta">{propLine(p)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- 时钟 -->
    <section class="zone">
      <header class="zone-head">
        <span class="zone-title">时钟</span>
        <span class="zone-count">{clockCount}</span>
      </header>
      {#if clockCount === 0}
        <p class="empty">还没有时钟表条目，对 AI 说「记一段故事时间」即可登记。</p>
      {:else}
        <ul class="rows">
          {#each ledger.clock as c, i (i)}
            <li class="row">
              <span class="row-meta">{clockLine(c)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- 知情地图 -->
    <section class="zone">
      <header class="zone-head">
        <span class="zone-title">知情</span>
        <span class="zone-count">{knowledgeCount}</span>
      </header>
      {#if knowledgeCount === 0}
        <p class="empty">还没有知情地图条目，对 AI 说「建知情地图」即可创建。</p>
      {:else}
        <ul class="rows">
          {#each ledger.knowledge as k (k.character)}
            <li class="row">
              <span class="row-name">{k.character}</span>
              <span class="row-meta">{knowledgeLine(k)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<style>
  .ctx {
    display: flex;
    flex-direction: column;
    gap: 12px;
    font-size: 12.5px;
    color: var(--ink);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .title {
    font-weight: 600;
    font-size: 12.5px;
  }
  .hint {
    flex: 1;
    font-size: 11px;
    color: var(--muted);
  }
  .refresh {
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 5px;
    color: var(--muted);
    transition: background var(--t-hover), color var(--t-hover);
    flex: none;
  }
  .refresh:hover {
    background: color-mix(in srgb, var(--muted) 12%, transparent);
    color: var(--ink);
  }
  .stamp {
    font-size: 10.5px;
    color: var(--muted);
    margin-top: -8px;
    margin-left: 2px;
  }
  .status {
    padding: 10px 11px;
    border: 1px dashed var(--line);
    border-radius: 7px;
    font-size: 11.5px;
    color: var(--muted);
  }
  .status.err {
    border-color: var(--danger);
    color: var(--danger);
  }
  .zone {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .zone-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--line);
  }
  .zone-title {
    font-weight: 600;
    font-size: 12px;
    letter-spacing: 0.04em;
  }
  .zone-count {
    font-size: 10.5px;
    color: var(--muted);
    padding: 0 6px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--muted) 8%, transparent);
    min-width: 18px;
    text-align: center;
  }
  .empty {
    font-size: 11.5px;
    color: var(--muted);
    line-height: 1.55;
    margin: 0;
    padding: 6px 8px;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 3px;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 5px 8px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--paper) 70%, var(--panel));
    border: 1px solid var(--line);
    line-height: 1.4;
  }
  .row-name {
    font-weight: 600;
    font-size: 12px;
    word-break: break-word;
  }
  .row-meta {
    font-size: 11px;
    color: var(--muted);
    word-break: break-word;
  }
</style>
