<script lang="ts">
  // 结构树（v3）：树头新建章/卷（A1）、搜索（B9：卷/章/场）、卷折叠、章状态点+字数+目标进度条（B5）、
  // 场级大纲导航（B9）、双击重命名（A2）、卷/章拖拽重排（A3，事务化重编号）、底部回收站。
  //
  // 拖拽用 pointer 事件实现（不用 HTML5 DnD）：Tauri WebView2 下 dragover/drop 不可靠
  // （出现系统 🚫 禁止光标、松手无动作），指针实现跨引擎一致，有效区/指示线完全可控。
  import { iconSvg } from '../../lib/icons.js';
  import { statusVar } from '../../theme.js';
  import { work } from '../../lib/work.svelte.js';
  import { dialog } from '../../lib/dialog.svelte.js';
  import { MANUSCRIPT_DIR, TRASH_DIR } from '../../lib/paths.js';
  import type { ChapterNode, VolumeNode } from '../../lib/types.js';

  let query = $state('');
  /** 重命名现场：{ kind: 'ch'|'vol', key, draft }。 */
  let renaming = $state<{ kind: 'ch' | 'vol'; key: string; draft: string } | null>(null);
  /** 卷折叠态（title → 折叠）。 */
  let collapsed = $state<Record<string, boolean>>({});

  // ---------- 拖拽现场（pointer 实现，A3） ----------
  interface DragState {
    kind: 'ch' | 'vol';
    /** ch: relPath；vol: 卷 title。 */
    key: string;
    /** ch 所属卷 title（跨卷无效区判定）；vol 拖拽时为 undefined。 */
    volTitle: string | undefined;
    startX: number;
    startY: number;
    /** 位移超阈值才进入拖拽态（否则视为普通点击）。 */
    active: boolean;
    x: number;
    y: number;
    /** 当前指针所在的有效区类型：ch 行 / 卷尾部空区 / 卷行。 */
    zone: 'ch' | 'end' | 'vol' | null;
  }
  let drag = $state<DragState | null>(null);
  /** 落点指示：ch 落点行 relPath；end 落点卷 title（卷尾）；vol 落点卷 title（插到该卷前）；vol-end 卷列尾部（移到最末）。 */
  let dropTarget = $state<{ kind: 'ch' | 'end' | 'vol' | 'vol-end'; key: string } | null>(null);

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

  // ---------- 新建（A1；WebView2 无 window.prompt，走壳内对话框） ----------
  async function newChapter(): Promise<void> {
    const targetVol = volumeForNew();
    const title = await dialog.prompt({
      message: targetVol ? `新建章（${targetVol.title}）标题，留空=新章` : '新建章（manuscript 根）标题，留空=新章',
      placeholder: '章标题（不含编号，自动续号）',
    });
    if (title === null) return;
    await work.createChapter(targetVol ? targetVol.title : null, title.trim() || undefined);
  }

  async function newVolume(): Promise<void> {
    const title = await dialog.prompt({
      message: '新卷标题，留空=新卷',
      placeholder: '卷标题（不含编号，自动续号）',
    });
    if (title === null) return;
    await work.createVolume(title.trim() || undefined);
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
    return `${MANUSCRIPT_DIR}${title}`;
  }

  // ---------- 拖拽重排（A3，pointer 实现） ----------
  function dragStart(e: PointerEvent, kind: 'ch' | 'vol', key: string, volTitle?: string): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    // 输入框/按钮上的按下不拖（重命名输入、软删按钮、图标按钮）
    if (target.closest('.rename-input, .icon-btn, .del')) return;
    // 捕获指针：拖出窗口/面板边界后松手也能收到 pointerup，避免拖拽态卡死（仅 Esc 可恢复）
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // jsdom/个别 WebView2 版本不支持捕获：忽略，事件仍走 window 监听
    }
    drag = { kind, key, volTitle, startX: e.clientX, startY: e.clientY, active: false, x: e.clientX, y: e.clientY, zone: null };
    dropTarget = null;
  }

  function dragMove(e: PointerEvent): void {
    const d = drag;
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 5) return; // 阈值内=点击
      drag = { ...d, active: true };
    }
    const cur = drag!;
    drag = { ...cur, x: e.clientX, y: e.clientY, zone: hitZone(e.clientX, e.clientY) };
    updateDropTarget();
  }

  function dragEnd(e?: PointerEvent): void {
    const d = drag;
    if (!d) return;
    const wasActive = d.active;
    if (wasActive) commitDrop(d);
    drag = null;
    dropTarget = null;
    if (wasActive) swallowNextClick(e);
  }

  /** pointercancel（指针被系统抢占/窗口失焦等）：取消拖拽现场，不提交落点。 */
  function cancelDrag(): void {
    if (!drag) return;
    drag = null;
    dropTarget = null;
  }

  /** 拖拽后吞掉紧随的 click（防止松手瞬间打开被落点/源行）。 */
  function swallowNextClick(_e?: PointerEvent): void {
    const h = (ev: MouseEvent): void => {
      ev.stopPropagation();
      ev.preventDefault();
      window.removeEventListener('click', h, true);
    };
    window.addEventListener('click', h, true);
  }

  /** 指针所在的有效区：章行 / 卷尾空区 / 卷行 / 卷列尾部；无效区返回 null（无指示、无 🚫）。 */
  function hitZone(x: number, y: number): DragState['zone'] | null {
    const d = drag;
    if (!d) return null;
    const el = document.elementFromPoint(x, y);
    const row = el?.closest<HTMLElement>('[data-drop]');
    const zone = row?.dataset['drop'] ?? null;
    if (!zone) return null;
    if (d.kind === 'vol') {
      if (zone.startsWith('vol:')) return 'vol';
      if (zone === 'vol-end') return 'end';
      return null;
    }
    // ch：只有同卷的章行 / 同卷卷尾空区有效
    if (zone.startsWith('ch:')) {
      const rel = zone.slice(3);
      const vol = work.structure.find((v) => v.children.some((c) => c.relPath === rel));
      return vol?.title === d.volTitle ? 'ch' : null;
    }
    if (zone.startsWith('end:')) {
      return zone.slice(4) === d.volTitle ? 'end' : null;
    }
    return null;
  }

  function updateDropTarget(): void {
    const d = drag;
    if (!d) return;
    const el = document.elementFromPoint(d.x, d.y);
    const row = el?.closest<HTMLElement>('[data-drop]');
    const zone = row?.dataset['drop'] ?? null;
    if (d.kind === 'vol') {
      // 卷拖拽：卷行（插到该卷前）/ 卷列尾部（移到最末）
      if (d.zone === 'vol' && zone?.startsWith('vol:')) {
        dropTarget = { kind: 'vol', key: zone.slice(4) };
      } else if (d.zone === 'end' && zone === 'vol-end') {
        dropTarget = { kind: 'vol-end', key: '' };
      } else {
        dropTarget = null;
      }
      return;
    }
    if (d.zone === 'ch' && zone?.startsWith('ch:')) {
      dropTarget = { kind: 'ch', key: zone.slice(3) };
    } else if (d.zone === 'end' && zone?.startsWith('end:')) {
      dropTarget = { kind: 'end', key: zone.slice(4) };
    } else {
      dropTarget = null;
    }
  }

  function commitDrop(d: DragState): void {
    const t = dropTarget;
    if (!t) return;
    if (d.kind === 'ch') {
      const from = d.key;
      const vol = work.structure.find((v) => v.title === d.volTitle);
      if (!vol || t.kind === 'end') {
        if (vol && t.kind === 'end') {
          const fromIdx = vol.children.findIndex((c) => c.relPath === from);
          if (fromIdx !== -1 && fromIdx !== vol.children.length - 1) {
            void work.moveChapter(from, vol.children.length - 1);
          }
        }
        return;
      }
      const idx = vol.children.findIndex((c) => c.relPath === t.key);
      const fromIdx = vol.children.findIndex((c) => c.relPath === from);
      if (idx === -1 || fromIdx === -1 || from === t.key) return;
      const toIndex = fromIdx < idx ? idx - 1 : idx; // 插入到落点行之前
      void work.moveChapter(from, toIndex);
    } else {
      const from = d.key;
      const fromIdx = work.structure.findIndex((x) => x.title === from);
      if (fromIdx === -1) return;
      let toIndex: number;
      if (t.kind === 'vol-end') {
        toIndex = work.structure.length - 1; // 卷列尾部 → 移到最末位
      } else {
        if (t.kind !== 'vol' || t.key === from) return;
        const idx = work.structure.findIndex((x) => x.title === t.key);
        if (idx === -1) return;
        toIndex = fromIdx < idx ? idx - 1 : idx; // 插到落点卷之前
      }
      if (toIndex === fromIdx) return;
      void work.moveVolume(volDir(from), toIndex);
    }
  }

  /** 拖拽提示：仅拖拽激活时显示；无效区（跨卷）给明确说明，不用系统禁止光标。 */
  const dragHint = $derived.by(() => {
    const d = drag;
    if (!d?.active) return '';
    if (d.kind === 'vol') return '松开即重排卷序（自动重编卷号，标题不动）';
    const inOwn = d.zone !== null;
    if (!inOwn) return '仅支持在本卷内重排：拖到本卷的章行或卷尾松开（跨卷移动不支持）';
    return '松开即重排：落位后自动从第 1 章起重编号，标题不动';
  });

  /** 幽灵标签文本：章 relPath → 章标题。 */
  function chapterTitleOf(relPath: string): string {
    return work.findChapter(relPath)?.title ?? relPath.split('/').pop()?.replace(/\.md$/, '') ?? relPath;
  }

  // 拖拽期间 Esc 取消
  function onDragKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && drag) {
      drag = null;
      dropTarget = null;
    }
  }

  // ---------- 软删 ----------
  async function confirmDelete(ch: ChapterNode): Promise<void> {
    const ok = await dialog.confirm({
      message: `删除「${ch.title}」？文件移入 ${TRASH_DIR}（软删，可找回）。`,
      okLabel: '删除',
      danger: true,
    });
    if (ok) void work.deleteChapter(ch.relPath);
  }

  function fmtWc(n: number): string {
    if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
    return n.toLocaleString('zh-CN');
  }
  function fmtWcFull(n: number): string {
    return n.toLocaleString('zh-CN');
  }

  // ---------- 回收站：domain 无 list_trash，壳走 localStorage 跟踪；找回=读 trash 写回原路径 ----------
  let trashOpen = $state(false);
  let trashBusy = $state(false);
  const trashEntries = $derived(work.listTrash());

  function trashNameOf(trashPath: string): string {
    return trashPath.split('/').pop()?.replace(/-\d+\.md$/, '.md') ?? trashPath;
  }
  function trashTimeOf(deletedAt: number): string {
    const d = new Date(deletedAt);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  async function restoreOne(trashPath: string): Promise<void> {
    if (trashBusy) return;
    trashBusy = true;
    try {
      await work.restoreTrash(trashPath);
    } finally {
      trashBusy = false;
    }
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
</script>

<svelte:window
  onpointermove={dragMove}
  onpointerup={dragEnd}
  onpointercancel={cancelDrag}
  onkeydown={onDragKeydown}
/>

<nav class="tree" class:dragging={drag?.active}>
  <div class="head">
    <span class="label">结 构</span>
    <button class="icon-btn" title="新建章(A1：自动续编号 + frontmatter 模板)" onclick={() => void newChapter()} aria-label="新建章">{@html iconSvg('doc', 14)}</button>
    <button class="icon-btn" title="新建卷(A1)" onclick={() => void newVolume()} aria-label="新建卷">{@html iconSvg('folder', 14)}</button>
  </div>

  <div class="search">
    {@html iconSvg('search', 12, 2)}
    <input type="text" placeholder="搜索卷 / 章 / 场(B9)" bind:value={query} />
  </div>

  <div class="body">
    {#if work.loading && work.structure.length === 0}
      <p class="empty">结构树加载中…</p>
    {:else if work.structure.length === 0}
      <p class="empty">manuscript 下还没有章节，点上方新建。</p>
    {/if}

    {#each work.structure as vol (vol.title)}
      {#if volVisible(vol)}
        <div class="vol" class:closed={collapsed[vol.title]}>
          <div
            class="vol-row"
            class:drop-zone={drag?.kind === 'vol'}
            class:drop-target={drag?.kind === 'vol' && dropTarget?.kind === 'vol' && dropTarget.key === vol.title && drag.key !== vol.title}
            role="button"
            tabindex="0"
            data-drop={`vol:${vol.title}`}
            onpointerdown={(e) => dragStart(e, 'vol', vol.title)}
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

          <div class="ch-list" class:drop-end={drag?.kind === 'ch' && dropTarget?.kind === 'end' && dropTarget.key === vol.title} role="list" data-drop={`end:${vol.title}`}>
            {#each vol.children as ch (ch.relPath)}
              {#if chVisible(ch)}
                <div
                  class="ch-row"
                  class:active={work.current?.relPath === ch.relPath}
                  class:dragging={drag?.kind === 'ch' && drag.key === ch.relPath}
                  class:drop-target={drag?.kind === 'ch' && dropTarget?.kind === 'ch' && dropTarget.key === ch.relPath && drag.key !== ch.relPath}
                  data-drop={`ch:${ch.relPath}`}
                  onpointerdown={(e) => dragStart(e, 'ch', ch.relPath, vol.title)}
                  onclick={(e) => {
                    if ((e.target as HTMLElement).closest('.rename-input, .icon-btn')) return;
                    void work.openChapter(ch);
                  }}
                  onkeydown={(e) => e.key === 'Enter' && void work.openChapter(ch)}
                  role="button"
                  tabindex="0"
                >
                  <span class="grip" title="拖拽改序(A3)：落位后自动从第 1 章起重编号，跨卷不支持">{@html iconSvg('grip', 12)}</span>
                  <i class="status" style:background={statusVar(ch.status)} title={ch.status ?? '无状态'}></i>
                  {#if ch.blueprint === 'locked'}<i class="bp" class:locked={true} title="blueprint: locked(碰撞已放行)"></i>{:else if ch.blueprint === 'draft'}<i class="bp" class:draft={true} title="blueprint: draft(碰撞进行中)"></i>{/if}
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
                  <button class="del" title={`软删进 ${TRASH_DIR}`} onclick={(e) => { e.stopPropagation(); void confirmDelete(ch); }} aria-label="软删章节">×</button>
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
                          class:current={work.current?.relPath === ch.relPath && work.currentScene === sc.title}
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
            {#if drag?.kind === 'ch' && vol.children.some((c) => c.relPath === drag?.key)}
              {#if dragHint}
                <div class="drag-hint" class:warn={drag.zone === null}>{dragHint}</div>
              {/if}
            {/if}
          </div>
        </div>
      {/if}
    {/each}

    {#if drag?.kind === 'vol' && dragHint}
      <div class="drag-hint">{dragHint}</div>
    {/if}
    {#if drag?.kind === 'vol' && work.structure.length > 0}
      <div class="vol-end" class:drop-target={dropTarget?.kind === 'vol-end'} data-drop="vol-end"></div>
    {/if}
  </div>

  {#if drag?.active}
    <div class="ghost" style:left="{drag.x + 14}px" style:top="{drag.y + 10}px">
      {drag.kind === 'ch' ? chapterTitleOf(drag.key) : drag.key}
    </div>
  {/if}

  <div class="foot">
    <button
      class="trash-row"
      class:open={trashOpen}
      onclick={() => (trashOpen = !trashOpen)}
      aria-expanded={trashOpen}
      title={`软删章在这里（${TRASH_DIR}），可一键找回`}
    >
      {@html iconSvg('trash', 13)}
      <span>回收站 · 软删章（{TRASH_DIR}）</span>
      {#if trashEntries.length > 0}<i class="n">{trashEntries.length}</i>{/if}
    </button>
    {#if trashOpen}
      <div class="trash-panel">
        {#if trashEntries.length === 0}
          <p class="empty">回收站空。软删的章会出现在这里。</p>
        {:else}
          {#each trashEntries as e (e.trashPath)}
            <div class="trash-item">
              <div class="ti-meta">
                <span class="ti-name" title={e.relPath}>{trashNameOf(e.trashPath)}</span>
                <span class="ti-time">{trashTimeOf(e.deletedAt)}</span>
              </div>
              <button class="ti-btn" disabled={trashBusy} onclick={() => void restoreOne(e.trashPath)} title={`找回：写回 ${e.relPath}`}>找回</button>
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
</nav>

<style>
  .tree {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--panel);
  }
  /* 拖拽期间禁止整树文本选择 */
  .tree.dragging,
  .tree.dragging * {
    user-select: none;
    cursor: grabbing;
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
    position: relative;
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
  .vol-row.drop-zone {
    cursor: grab;
  }
  .vol-row.drop-zone:active {
    cursor: grabbing;
  }
  /* 卷行落点：指示线在顶边（插到该卷前） */
  .vol-row.drop-target {
    box-shadow: inset 0 2px 0 var(--accent);
  }
  /* 卷列尾部落点：移到最末（指示线在底边） */
  .vol-end {
    height: 12px;
    margin: 2px 8px 0;
    border-radius: 6px;
    transition: background var(--t-hover);
  }
  .vol-end.drop-target {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    box-shadow: inset 0 -2px 0 var(--accent);
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
    position: relative;
  }
  .vol.closed .ch-list {
    display: none;
  }
  /* 卷尾落点：ch-list 整区高亮（含末行之后），指示可落到卷尾 */
  .ch-list.drop-end {
    border-radius: 6px;
    box-shadow: inset 0 -2px 0 var(--accent);
    background: color-mix(in srgb, var(--accent) 4%, transparent);
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
    opacity: 0.6;
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
  /* 批一③ collision blueprint 徽标：与 status 同款 6px，挂在 status 圆点旁 */
  .ch-row .bp {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: none;
    margin-left: 4px;
    box-sizing: border-box;
  }
  /* locked=实心点（碰撞已放行，accent） */
  .ch-row .bp.locked {
    background: var(--accent);
    border: none;
  }
  /* draft=空心圈（碰撞进行中，无填充边框） */
  .ch-row .bp.draft {
    background: transparent;
    border: 1.5px solid var(--accent);
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
  .drag-hint.warn {
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 7%, transparent);
    border-color: color-mix(in srgb, var(--danger) 35%, var(--line));
  }
  /* 拖拽幽灵标签（跟随指针，pointer-events 关掉避免遮挡命中测试） */
  .ghost {
    position: fixed;
    z-index: 300;
    max-width: 220px;
    padding: 4px 10px;
    font-size: 12px;
    color: var(--ink);
    background: var(--panel);
    border: 1px solid var(--accent-line);
    border-radius: 6px;
    box-shadow: var(--shadow-pop);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
    user-select: none;
  }
  .foot {
    border-top: 1px solid var(--line);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .trash-row {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 28px;
    padding: 0 8px;
    font-size: 12px;
    color: var(--muted);
    border: none;
    background: transparent;
    border-radius: 6px;
    cursor: pointer;
    transition: background var(--t-hover), color var(--t-hover);
    text-align: left;
  }
  .trash-row:hover {
    background: color-mix(in srgb, var(--muted) 8%, transparent);
  }
  .trash-row.open {
    color: var(--ink);
  }
  .trash-row .n {
    min-width: 16px;
    height: 16px;
    padding: 0 5px;
    border-radius: 8px;
    background: var(--muted);
    color: var(--panel);
    font-size: 10.5px;
    line-height: 16px;
    text-align: center;
    margin-left: auto;
  }
  .trash-panel {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 4px 0;
    max-height: 180px;
    overflow-y: auto;
  }
  .trash-panel .empty {
    margin: 4px 4px 6px;
    padding: 8px;
    font-size: 11px;
    color: var(--muted);
    text-align: center;
    border: 1px dashed var(--line);
    border-radius: 6px;
  }
  .trash-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--paper);
    font-size: 11.5px;
  }
  .ti-meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .ti-name {
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ti-time {
    font-size: 10px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .ti-btn {
    flex: none;
    height: 22px;
    padding: 0 8px;
    font-size: 11.5px;
    border: 1px solid var(--accent-line);
    border-radius: 5px;
    background: var(--accent-soft);
    color: var(--accent);
    cursor: pointer;
    transition: background var(--t-hover), border-color var(--t-hover);
  }
  .ti-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }
  .ti-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
