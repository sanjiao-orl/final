<script lang="ts">
  // 会话栏（B7）：挂载 chips（无归属/本章/卷/作品）+ 会话搜索/列表 + 重命名/归档。
  // 本章挂载按 frontmatter 稳定 id（ch:<uuid>），章重排改名不失效；卷按卷目录名；作品根 = work。
  import { iconSvg } from '../../lib/icons.js';
  import { chat } from '../../lib/chat.svelte.js';
  import { work } from '../../lib/work.svelte.js';

  type MountScope = 'none' | 'chapter' | 'volume' | 'work';

  function currentScope(): MountScope {
    if (chat.scope === '') return 'none';
    if (chat.scope === 'work') return 'work';
    if (chat.scope.startsWith('vol:')) return 'volume';
    return 'chapter';
  }

  function scopeOf(m: MountScope): string {
    if (m === 'none') return '';
    if (m === 'work') return 'work';
    if (m === 'chapter') {
      const cur = work.current;
      if (!cur) return '';
      // 稳定 id 优先；旧章无 id 时退回 relPath（重排改名后失效，仅旧数据）
      return cur.id ? `ch:${cur.id}` : `ch:${cur.relPath}`;
    }
    if (m === 'volume') {
      const cur = work.current;
      const vol = cur ? work.structure.find((v) => v.children.some((c) => c.relPath === cur.relPath)) : undefined;
      return vol ? `vol:${vol.title}` : '';
    }
    return '';
  }

  function mount(m: MountScope): void {
    const s = scopeOf(m);
    if (s === '' && m !== 'none') return; // 没有可挂载的目标（如未开章）
    void chat.setScope(s);
  }

  const MOUNTS: { id: MountScope; label: string; title: string }[] = [
    { id: 'none', label: '无归属', title: '不挂在任何章/卷上' },
    { id: 'chapter', label: '本章', title: 'B7：按章稳定 id 关联，重排改名不失效' },
    { id: 'volume', label: '本卷', title: 'B7：会话可挂载任意层级' },
    { id: 'work', label: '作品', title: 'B7：作品根' },
  ];

  /** 会话归属短标签（列表 meta 行）。 */
  function scopeTag(scope: string): string {
    if (scope === '') return '无归属';
    if (scope === 'work') return '作品';
    if (scope.startsWith('vol:')) return scope.slice(4);
    if (scope.startsWith('ch:')) {
      const key = scope.slice(3);
      const node = work.findChapterById(key) ?? work.findChapter(key);
      return node ? node.title.replace(/^第\d+章·/, '') : '本章';
    }
    return scope.split('/').pop() ?? scope;
  }

  /** 时间短标签：今天显示 HH:MM，昨天显示 昨日，更早显示 MM-DD。 */
  function timeOf(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return `${p(d.getHours())}:${p(d.getMinutes())}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return '昨日';
    return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
</script>

<div class="scope">
  <span class="lbl">挂 载</span>
  <div class="chips">
    {#each MOUNTS as m (m.id)}
      <button
        class="chip"
        class:on={currentScope() === m.id}
        disabled={m.id !== 'none' && scopeOf(m.id) === ''}
        onclick={() => mount(m.id)}
        title={m.title}
      >{m.label}</button
      >
    {/each}
  </div>
</div>

<div class="search">
  {@html iconSvg('search', 12, 2)}
  <input type="text" placeholder="搜索会话(B7)" bind:value={chat.searchText} />
</div>

<div class="list">
  {#if chat.visibleSessions.length === 0}
    <p class="hint">{chat.searchText ? '没有匹配的会话' : '还没有会话。发一条消息即新建（挂载当前层级）。'}</p>
  {/if}
  {#each chat.visibleSessions as s (s.id)}
    <div
      class="row"
      class:on={chat.sessionId === s.id}
      role="button"
      tabindex="0"
      onclick={() => void chat.openSession(s.id)}
      onkeydown={(e) => e.key === 'Enter' && void chat.openSession(s.id)}
    >
      {#if chat.renamingId === s.id}
        <input
          class="rename-input"
          bind:value={chat.renameDraft}
          onclick={(e) => e.stopPropagation()}
          onkeydown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') chat.commitRename();
            if (e.key === 'Escape') chat.cancelRename();
          }}
          onblur={() => chat.commitRename()}
        />
      {:else}
        <span class="name" role="button" tabindex="0" ondblclick={(e) => { e.stopPropagation(); chat.startRename(s.id); }} title="双击重命名">{chat.sessionTitle(s)}</span>
      {/if}
      <span class="meta">{scopeTag(s.scope)} · {timeOf(s.updatedAt)}</span>
      <span class="ops">
        <button class="icon-btn" title="重命名(B7)" onclick={(e) => { e.stopPropagation(); chat.startRename(s.id); }} aria-label="重命名会话">{@html iconSvg('rename', 13)}</button>
        <button class="icon-btn" title="归档(B7)" onclick={(e) => { e.stopPropagation(); chat.archiveSession(s.id); }} aria-label="归档会话">{@html iconSvg('archive', 13)}</button>
      </span>
    </div>
  {/each}
</div>

<style>
  .scope {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }
  .lbl {
    font-size: 10.5px;
    letter-spacing: 0.18em;
    color: var(--muted);
    flex: none;
  }
  .chips {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .chip {
    height: 21px;
    padding: 0 9px;
    font-size: 11px;
    border-radius: 11px;
    border: 1px solid var(--line);
    color: var(--muted);
    transition: all var(--t-hover);
  }
  .chip.on {
    background: var(--accent-soft);
    border-color: var(--accent-line);
    color: var(--accent);
  }
  .chip:not(.on):hover:not(:disabled) {
    border-color: var(--muted);
    color: var(--ink);
  }
  .chip:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .search {
    position: relative;
    margin-bottom: 8px;
  }
  .search :global(svg) {
    position: absolute;
    left: 7px;
    top: 7px;
    width: 12px;
    height: 12px;
    color: var(--muted);
    pointer-events: none;
  }
  .search input {
    width: 100%;
    height: 26px;
    padding: 0 8px 0 24px;
    font-size: 12px;
    background: color-mix(in srgb, var(--muted) 7%, transparent);
    border: 1px solid transparent;
    border-radius: 6px;
    outline: none;
    transition: border-color var(--t-hover), background var(--t-hover);
  }
  .search input:focus {
    border-color: var(--accent-line);
    background: var(--panel);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .hint {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.7;
    padding: 4px 2px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 3px 8px;
    border-radius: 6px;
    cursor: pointer;
    transition: background var(--t-hover);
  }
  .row:hover {
    background: color-mix(in srgb, var(--muted) 8%, transparent);
  }
  .row.on {
    background: var(--accent-soft);
  }
  .row.on .name {
    color: var(--accent);
    font-weight: 600;
  }
  .name {
    flex: 1;
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 2px 4px;
    border-radius: 4px;
    cursor: text;
  }
  .meta {
    font-size: 10.5px;
    color: var(--muted);
    flex: none;
  }
  .ops {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity var(--t-hover);
  }
  .row:hover .ops,
  .row:focus-within .ops {
    opacity: 1;
  }
  .icon-btn {
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 5px;
    color: var(--muted);
    transition: background var(--t-hover), color var(--t-hover);
  }
  .icon-btn:hover {
    background: color-mix(in srgb, var(--muted) 12%, transparent);
    color: var(--ink);
  }
  .rename-input {
    flex: 1;
    min-width: 0;
    height: 22px;
    padding: 0 6px;
    font-size: 12px;
    border: 1px solid var(--accent-line);
    border-radius: 4px;
    background: var(--panel);
    outline: none;
  }
</style>
