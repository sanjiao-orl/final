<script lang="ts">
  // 结构树（v3）：树头新建章/卷（A1）、搜索（B9：卷/章/场）、卷折叠、章状态点+字数+目标进度条（B5）、
  // 场级大纲导航（B9）、双击重命名（A2）、卷内拖拽重排（A3，事务化重编号）、底部回收站。
  import { iconSvg } from '../../lib/icons.js';
  import { statusVar } from '../../theme.js';
  import { work } from '../../lib/work.svelte.js';
  import type { ChapterNode, VolumeNode } from '../../lib/types.js';

  let query = $state('');
  /** 重命名现场：{ kind: 'ch'|'vol', key, draft }。 */
  let renaming = $state<{ kind: 'ch' | 'vol'; key: string; draft: string } | null>(null);
  /** 卷折叠态（title → 折叠）。 */
  let collapsed = $state<Record<string, boolean>>({});
  /** 拖拽现场。 */
  let dragging = $state<{ kind: 'ch' | 'vol'; key: string } | null>(null);
  let dropTarget = $state<string | null>(null); // 落点行的 key（章 relPath / 卷 title）

  const q = $derived(query.trim().toLowerCase());

  /** 搜索命中：章名/场名包含查询。空查询 = 全显。 */
  function volVisible(v: VolumeNode): boolean {
    return !q || v.title.toLowerCase().includes(q) || v.children.some((c) => chVisible(c));
  }
  function chVisible(c: ChapterNode): boolean {
    return !q || c.title.toLowerCase().includes(q) || c.scenes.some((s) => s.title.toLowerCase().includes(q));
  }
  function sceneVisible(s: { title: string }): boolean {
    return !q || s.title.toLowerCase().includes(q);
  }

  /** 场大纲展示：当前章常显（含搜索中），搜索时全部命中章展开。 */
  function showScenes(c: ChapterNode): boolean {
    return work.current?.relPath === c.relPath || (!!q && chVisible(c));
  }

  function toggleVol(v: VolumeNode): void {
    collapsed = { ...collapsed, [v.title]: !collapsed[v.title] };
  }

  // ---------- 新建（A1） ----------
  function newChapter(): void {
    const targetVol = volumeForNew();
    const title = window.prompt(`新建章${targetVol ? `（${targetVol.title}）` : '（manuscript 根）'}标题，留空=新章`, '');
    if (title === null) return;
    void work.createChapter(targetVol ? targetVol.title : null, title.trim() || undefined);
  }

  function newVolume(): void {
    const title = window.prompt('新卷标题，留空=新卷', '');
    if (title === null) return;
    void work.createVolume(title.trim() || undefined);
  }

  /** 新章落点：当前章所在卷 > 第一卷 > null（根）。 */
  function volumeForNew(): VolumeNode | null {
    const cur = work.current;
    if (cur) {
      const vol = work.structure.find((v) => v.children.some((c) => c.relPath === cur.relPath));
      if (vol) return vol;
    }
    return work.structure[0] ?? null;
  }

  // ---------- 重命名（A2） ----------
  function startRenameCh(c: ChapterNode): void {
    renaming = { kind: 'ch', key: c.relPath, draft: userTitleOf(c.title) };
  }
  function startRenameVol(v: VolumeNode): void {
    renaming = { kind: 'vol', key: v.title, draft: userTitleOf(v.title) };
  }
  function commitRename(): void {
    const r = renaming;
    renaming = null;
    if (!r || !r.draft.trim()) return;
    if (r.kind === 'ch') void work.renameChapter(r.key, r.draft.trim());
    else {
      const vol = work.structure.find((v) => v.title === r.key);
      if (vol) void work.renameVolume(volDir(vol.title), r.draft.trim());
    }
  }
  function userTitleOf(full: string): string {
    return full.replace(/^第[\d一二三四五六七八九十百]+[章卷]·/, '');
  }
  /** 卷 title → 目录 relPath（manuscript/卷名）。 */
  function volDir(title: string): string {
    return `manuscript/${title}`;
  }

  // ---------- 拖拽重排（A3） ----------
  function dragStartCh(e: DragEvent, c: ChapterNode): void {
    dragging = { kind: 'ch', key: c.relPath };
    e.dataTransfer?.setData('text/plain', c.relPath);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }
  function dragStartVol(e: DragEvent, v: VolumeNode): void {
    dragging = { kind: 'vol', key: v.title };
    e.dataTransfer?.setData('text/plain', v.title);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }
  function dragEnd(): void {
    dragging = null;
    dropTarget = null;
  }

  function dropOnChapter(e: DragEvent, vol: VolumeNode, ch: ChapterNode): void {
    e.preventDefault();
    if (!dragging || dragging.kind !== 'ch') return;
    const from = dragging.key;
    if (from === ch.relPath) return;
    // 仅同卷：目标章所在卷 = 拖源卷
    if (!vol.children.some((c) => c.relPath === from)) return;
    const idx = vol.children.findIndex((c) => c.relPath === ch.relPath);
    const fromIdx = vol.children.findIndex((c) => c.relPath === from);
    const toIndex = fromIdx < idx ? idx - 1 : idx; // 插入到落点行之前
    void work.moveChapter(from, toIndex);
    dragEnd();
  }

  function dropOnVolumeEnd(e: DragEvent, vol: VolumeNode): void {
    e.preventDefault();
    if (!dragging || dragging.kind !== 'ch') return;
    const from = dragging.key;
    if (!vol.children.some((c) => c.relPath === from)) return;
    const fromIdx = vol.children.findIndex((c) => c.relPath === from);
    if (fromIdx === vol.children.length - 1) return; // 已在末尾
    void work.moveChapter(from, vol.children.length - 1);
    dragEnd();
  }

  function dropOnVolume(e: DragEvent, v: VolumeNode): void {
    e.preventDefault();
    if (!dragging || dragging.kind !== 'vol') return;
    const from = dragging.key;
    if (from === v.title) return;
    const idx = work.structure.findIndex((x) => x.title === v.title);
    const fromIdx = work.structure.findIndex((x) => x.title === from);
    const toIndex = fromIdx < idx ? idx - 1 : idx;
    void work.moveVolume(volDir(from), toIndex);
    dragEnd();
  }

  function onDragOver(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  }

  function fmtWc(n: number): string {
    if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
    return n.toLocaleString('zh-CN');
  }
  function fmtWcFull(n: number): string {
    return n.toLocaleString('zh-CN');
  }

  /** B5 进度：wordCount / goal，0..1；无 goal 返回 null。 */
  function goalRatio(c: ChapterNode): number | null {
    if (!c.goal || c.goal <= 0) return null;
    return Math.min(1, c.wordCount / c.goal);
  }

  function volMeta(v: VolumeNode): string {
    const chs = v.children.length;
    const wc = v.children.reduce((s, c) => s + c.wordCount, 0);
    return `${chs} 章 · ${fmtWc(wc)}字`;
  }

  function confirmDelete(ch: ChapterNode): void {
    if (window.confirm(`删除「${ch.title}」？文件移入 .novel/trash/（软删，可找回）。`)) {
      void work.deleteChapter(ch.relPath);
    }
  }
</script>

<nav class="tree">
  <div class="head">
    <span class="label">结 构</span>
    <button class="icon-btn" title="新建章(A1：自动续编号 + frontmatter 模板)" onclick={newChapter} aria-label="新建章">{@html iconSvg('doc', 14)}</button>
    <button class="icon-btn" title="新建卷(A1)" onclick={newVolume} aria-label="新建卷">{@html iconSvg('folder', 14)}</button>
  </div>

  <div class="search">
    {@html iconSvg('search', 12, 2)}
    <input type="text" placeholder="搜索卷 / 章 / 场(B9)" bind:value={query} />
  </div>

  <div class="body">
    {#if work.structure.length === 0}
      <p class="empty">manuscript 下还没有章节，点上方新建。</p>
    {/if}

    {#each work.structure as vol (vol.title)}
      {#if volVisible(vol)}
        <div class="vol" class:closed={collapsed[vol.title]}>
          <div
            class="vol-row"
            role="button"
            tabindex="0"
            draggable="true"
            ondragstart={(e) => dragStartVol(e, vol)}
            ondragend={dragEnd}
            ondragover={onDragOver}
            ondrop={(e) => dropOnVolume(e, vol)}
            onclick={(e) => {
              if ((e.target as HTMLElement).closest('.rename-input, .icon-btn')) return;
              toggleVol(vol);
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter' && !(e.target as HTMLElement).closest('.rename-input, .icon-btn')) toggleVol(vol);
            }}
          >
            <span class="grip" title="拖拽改卷序(A3)">{@html iconSvg('grip', 12)}</span>
            <span class="caret" style:transform={collapsed[vol.title] ? 'rotate(-90deg)' : 'none'}>{@html iconSvg('caret', 14, 2)}</span>
            {#if renaming?.kind === 'vol' && renaming.key === vol.title}
              <input
                class="rename-input"
                bind:value={renaming.draft}
                onclick={(e) => e.stopPropagation()}
                onkeydown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') renaming = null;
                }}
                onblur={commitRename}
              />
            {:else}
              <span class="name" role="button" tabindex="0" ondblclick={(e) => { e.stopPropagation(); startRenameVol(vol); }} onkeydown={(e) => e.key === 'Enter' && (e.stopPropagation(), startRenameVol(vol))} title="双击重命名(A2)">{vol.title}</span>
            {/if}
            <span class="meta">{volMeta(vol)}</span>
          </div>

          <div class="ch-list" role="list" ondragover={onDragOver} ondrop={(e) => dropOnVolumeEnd(e, vol)}>
            {#each vol.children as ch (ch.relPath)}
              {#if chVisible(ch)}
                <div
                  class="ch-row"
                  class:active={work.current?.relPath === ch.relPath}
                  class:dragging={dragging?.kind === 'ch' && dragging.key === ch.relPath}
                  class:drop-target={dropTarget === ch.relPath}
                  draggable="true"
                  ondragstart={(e) => dragStartCh(e, ch)}
                  ondragend={dragEnd}
                  ondragover={(e) => { onDragOver(e); dropTarget = ch.relPath; }}
                  ondragleave={() => { if (dropTarget === ch.relPath) dropTarget = null; }}
                  ondrop={(e) => dropOnChapter(e, vol, ch)}
                  role="button"
                  tabindex="0"
                  onclick={(e) => {
                    if ((e.target as HTMLElement).closest('.rename-input, .icon-btn')) return;
                    void work.openChapter(ch);
                  }}
                  onkeydown={(e) => e.key === 'Enter' && void work.openChapter(ch)}
                >
                  <span class="grip" title="拖拽改序(A3)：落位后自动从第 1 章起重编号，跨卷不支持">{@html iconSvg('grip', 12)}</span>
                  <i class="status" style:background={statusVar(ch.status)} title={ch.status ?? '无状态'}></i>
                  {#if renaming?.kind === 'ch' && renaming.key === ch.relPath}
                    <input
                      class="rename-input"
                      bind:value={renaming.draft}
                      onclick={(e) => e.stopPropagation()}
                      onkeydown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') renaming = null;
                      }}
                      onblur={commitRename}
                    />
                  {:else}
                    <span class="name" role="button" tabindex="0" ondblclick={(e) => { e.stopPropagation(); startRenameCh(ch); }} onkeydown={(e) => e.key === 'Enter' && (e.stopPropagation(), startRenameCh(ch))} title="双击重命名(A2)">{ch.title}</span>
                  {/if}
                  <span class="wc">{goalRatio(ch) !== null ? `${fmtWcFull(ch.wordCount)}/${fmtWcFull(ch.goal!)}` : fmtWcFull(ch.wordCount)}</span>
                  <button class="del" title="软删进 .novel/trash/" onclick={(e) => { e.stopPropagation(); confirmDelete(ch); }} aria-label="软删章节">×</button>
                  {#if goalRatio(ch) !== null}
                    <span class="goal" class:done={goalRatio(ch) === 1} title={`目标 ${fmtWcFull(ch.goal!)} 字`}>
                      <i style:width={`${(goalRatio(ch)! * 100).toFixed(1)}%`}></i>
                    </span>
                  {/if}
                </div>

                {#if showScenes(ch)}
                  <div class="scene-list">
                    {#each ch.scenes as sc (ch.relPath + sc.line)}
                      {#if sceneVisible(sc)}
                        <div
                          class="scene-row"
                          class:current={work.current?.relPath === ch.relPath && work.pendingScene === null}
                          role="button"
                          tabindex="0"
                          onclick={() => void work.openChapter(ch, sc.title)}
                          onkeydown={(e) => e.key === 'Enter' && void work.openChapter(ch, sc.title)}
                        >{sc.title}</div
                        >
                      {/if}
                    {/each}
                  </div>
                {/if}
              {/if}
            {/each}
            {#if dragging?.kind === 'ch' && vol.children.some((c) => c.relPath === dragging?.key)}
              <div class="drag-hint">卷内拖拽重排(A3)：落位后自动从第 1 章起重编号，标题不动；跨卷移动不支持</div>
            {/if}
          </div>
        </div>
      {/if}
    {/each}
  </div>

  <div class="foot">
    <div class="trash-row" title="软删章在这里（.novel/trash/），移回原路径即找回">
      {@html iconSvg('trash', 13)}
      回收站 · 软删章（.novel/trash/）
    </div>
  </div>
</nav>

<style>
  .tree {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--panel);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px 8px;
  }
  .label {
    flex: 1;
    font-size: 11px;
    letter-spacing: 0.22em;
    color: var(--muted);
    user-select: none;
  }
  .icon-btn {
    width: 24px;
    height: 24px;
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
  .search {
    position: relative;
    padding: 0 12px 8px;
  }
  .search :global(svg) {
    position: absolute;
    left: 20px;
    top: 7px;
    width: 12px;
    height: 12px;
    color: var(--muted);
    pointer-events: none;
  }
  .search input {
    width: 100%;
    height: 26px;
    padding: 0 8px 0 26px;
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
  .body {
    flex: 1;
    overflow-y: auto;
    padding: 2px 6px 12px;
  }
  .empty {
    color: var(--muted);
    font-size: 12px;
    padding: 10px 8px;
  }
  .vol {
    margin-top: 4px;
  }
  .vol-row {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 30px;
    padding: 0 6px;
    border-radius: 6px;
    user-select: none;
    cursor: default;
    transition: background var(--t-hover);
  }
  .vol-row:hover {
    background: color-mix(in srgb, var(--muted) 8%, transparent);
  }
  .grip {
    width: 12px;
    flex: none;
    color: var(--line);
    opacity: 0;
    transition: opacity var(--t-hover);
    cursor: grab;
  }
  .vol-row:hover .grip,
  .ch-row:hover .grip {
    opacity: 1;
    color: var(--muted);
  }
  .caret {
    width: 14px;
    height: 14px;
    color: var(--muted);
    flex: none;
    display: inline-flex;
    transition: transform var(--t-hover);
  }
  .name {
    flex: 1;
    font-family: var(--body-font);
    font-size: 13.5px;
    font-weight: 600;
    letter-spacing: 0.05em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .vol .meta {
    font-size: 10.5px;
    color: var(--muted);
    flex: none;
  }
  .rename-input {
    flex: 1;
    min-width: 0;
    height: 22px;
    padding: 0 6px;
    font-size: 12.5px;
    border: 1px solid var(--accent-line);
    border-radius: 4px;
    background: var(--panel);
    outline: none;
  }
  .ch-list {
    padding: 1px 0 2px 20px;
  }
  .vol.closed .ch-list {
    display: none;
  }
  .ch-row {
    display: flex;
    align-items: center;
    gap: 5px;
    min-height: 28px;
    padding: 2px 6px 2px 4px;
    border-radius: 6px;
    cursor: pointer;
    transition: background var(--t-hover);
    position: relative;
  }
  .ch-row:hover {
    background: color-mix(in srgb, var(--muted) 8%, transparent);
  }
  .ch-row.active {
    background: var(--accent-soft);
  }
  .ch-row.active .name {
    color: var(--accent);
    font-weight: 600;
  }
  .ch-row.dragging {
    background: var(--panel);
    box-shadow: var(--shadow-pop);
    border: 1px solid var(--accent-line);
    opacity: 0.96;
  }
  .ch-row.drop-target {
    box-shadow: inset 0 2px 0 var(--accent);
  }
  .ch-row .status {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: none;
    margin-left: 2px;
  }
  .ch-row .name {
    font-family: var(--ui-font);
    font-size: 12.5px;
    font-weight: 400;
    letter-spacing: 0;
  }
  .ch-row.active .name {
    font-weight: 600;
  }
  .ch-row .wc {
    font-size: 10.5px;
    color: var(--muted);
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  .ch-row .del {
    font-size: 14px;
    color: var(--muted);
    padding: 0 4px;
    border-radius: 4px;
    opacity: 0;
    flex: none;
  }
  .ch-row:hover .del {
    opacity: 1;
  }
  .ch-row .del:hover {
    color: var(--danger);
  }
  .goal {
    position: absolute;
    left: 26px;
    right: 8px;
    bottom: 1px;
    height: 2px;
    border-radius: 1px;
    background: color-mix(in srgb, var(--muted) 16%, transparent);
    overflow: hidden;
    pointer-events: none;
  }
  .goal i {
    display: block;
    height: 100%;
    border-radius: 1px;
    background: var(--status-polish);
    transition: width 0.6s var(--ease-fold);
  }
  .goal.done i {
    background: var(--status-final);
  }
  .scene-list {
    padding: 0 0 4px 30px;
  }
  .scene-row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 6px;
    font-size: 12px;
    color: var(--muted);
    border-radius: 5px;
    cursor: pointer;
    transition: background var(--t-hover), color var(--t-hover);
  }
  .scene-row:hover {
    background: color-mix(in srgb, var(--muted) 8%, transparent);
    color: var(--ink);
  }
  .scene-row.current {
    color: var(--accent);
  }
  .scene-row::before {
    content: '';
    width: 8px;
    height: 1px;
    background: var(--line);
    flex: none;
  }
  .drag-hint {
    margin: 6px 4px 0;
    padding: 5px 8px;
    font-size: 11px;
    color: var(--status-polish);
    background: color-mix(in srgb, var(--status-polish) 8%, transparent);
    border: 1px dashed color-mix(in srgb, var(--status-polish) 35%, var(--line));
    border-radius: 6px;
  }
  .foot {
    border-top: 1px solid var(--line);
    padding: 6px;
  }
  .trash-row {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    padding: 0 8px;
    font-size: 12px;
    color: var(--muted);
    border-radius: 6px;
    cursor: pointer;
    transition: background var(--t-hover);
  }
  .trash-row:hover {
    background: color-mix(in srgb, var(--muted) 8%, transparent);
  }
</style>
