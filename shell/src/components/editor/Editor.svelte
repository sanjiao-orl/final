<script lang="ts">
  // 编辑器：TipTap 承载正文（HTML ↔ md 桥在 lib/markdown.ts），打字机滚动锁 42%，
  // 场景跳转按标题文本定位；章头元信息（status/pov/tags + 目标字数进度条 B5）；
  // 选区浮动条 → B1 多候选就地浮层（小改就地）或暂存区（大改进）；
  // 暂存候选内联删除线装饰；序列化/替换/插入入口注册到 work store。
  import { onDestroy, onMount } from 'svelte';
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import { htmlToMd, mdToHtml } from '../../lib/markdown.js';
  import { captureSelection, locateUnique } from '../../lib/pm-search.js';
  import { refreshSuggests, Suggest } from '../../lib/suggest.js';
  import { candidates } from '../../lib/candidates.svelte.js';
  import { settings } from '../../lib/settings.svelte.js';
  import { statusVar, layout } from '../../theme.js';
  import { work } from '../../lib/work.svelte.js';
  import SelectionPopover from './SelectionPopover.svelte';

  interface Props {
    html: string;
    typewriter: boolean;
    /** 打开后待跳转的场景标题（消费一次即清）。 */
    scene: string | null;
  }
  let { html, typewriter, scene }: Props = $props();

  let scroller: HTMLDivElement;
  let host: HTMLDivElement;
  let editor: Editor | undefined;

  /** 选区浮动条现场（非空选区时定位显示）。 */
  interface SelBar {
    top: number;
    left: number;
    from: number;
    to: number;
    chars: number;
  }
  let selBar = $state<SelBar | null>(null);
  let instruction = $state('');
  let rewriting = $state(false);
  let rewriteChars = $state(0);
  /** B1 浮层现场（就地打磨路径）。 */
  let popover = $state<{ x: number; y: number; maxTop: number; original: string; instruction: string } | null>(null);

  onMount(() => {
    editor = new Editor({
      element: host,
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
        Suggest.configure({
          getItems: () => candidates.items.filter((i) => i.chapter === work.current?.relPath),
          onAccept: (id) => {
            const c = candidates.items.find((i) => i.id === id);
            if (c) void candidates.adoptOne(c);
          },
          onReject: (id) => {
            const c = candidates.items.find((i) => i.id === id);
            if (c) void candidates.discardOne(c);
          },
        }),
      ],
      content: html,
      onUpdate: () => {
        work.dirty = true;
        if (typewriter) requestAnimationFrame(scrollCaret);
      },
      onSelectionUpdate: () => updateSelBar(),
    });
    work.registerEditor({
      getMd: () => (editor ? htmlToMd(editor.getHTML()) : ''),
      applyEdit,
      insertAfter,
    });
    if (scene) {
      jumpToScene(scene); // 场景跳转自己管光标与滚动
    } else {
      editor.commands.focus('end');
      if (typewriter) requestAnimationFrame(scrollCaret);
    }
    work.pendingScene = null;
  });

  // 同章场景点击不重建 Editor，靠 scene prop 变化跳转
  $effect(() => {
    if (scene && editor) {
      jumpToScene(scene);
      work.pendingScene = null;
    }
  });

  // 候选列表任何变化 → 重建删除线装饰
  $effect(() => {
    void candidates.revision;
    if (editor) refreshSuggests(editor.view);
  });

  // 浮层打开期间禁止选区条再弹
  $effect(() => {
    if (popover) selBar = null;
  });

  onDestroy(() => {
    work.registerEditor(null);
    editor?.destroy();
    editor = undefined;
  });

  /** 打字机滚动：把光标行拉回视口 42% 高度处（仅输入触发，点击/选择不触发）。 */
  function scrollCaret(): void {
    if (!editor) return;
    const { from } = editor.state.selection;
    if (from > editor.state.doc.content.size) return;
    const coords = editor.view.coordsAtPos(from);
    const rect = scroller.getBoundingClientRect();
    const delta = coords.top - (rect.top + rect.height * layout.typewriterRatio);
    if (Math.abs(delta) > 6) scroller.scrollBy({ top: delta });
  }

  /**
   * 选区浮动条定位（内容坐标：相对 scroller 滚动层）。
   * 主路径：浮动条顶与选区尾行顶对齐——覆盖的是选区自身(高亮,无感)，
   * 仅向下溢出约 7px 轻微擦过下一行字形上沿；段落/标题间隙场景零遮挡。
   * 视口放不下(选区贴文档尾)时兜底贴选区上方。
   */
  function updateSelBar(): void {
    if (!editor || rewriting || popover) return;
    const { from, to, empty } = editor.state.selection;
    if (empty || to - from < 2) {
      selBar = null;
      return;
    }
    const text = captureSelection(editor.state.doc, from, to);
    if (text.trim().length < 2) {
      selBar = null;
      return;
    }
    const start = editor.view.coordsAtPos(from);
    // to 恰在行尾时 coordsAtPos(to) 返回下一行顶部,取 to-1(选区内最后字符所在行)
    const end = editor.view.coordsAtPos(Math.max(from, to - 1));
    const srect = scroller.getBoundingClientRect();
    // 浮动条几何全在 theme.ts layout 里：barH 估算高度、gap 相对行顶偏移、行高 lineHeight 与排版对齐
    const barH = layout.selBarHeight;
    const startTop = start.top - srect.top + scroller.scrollTop;
    const endTop = end.top - srect.top + scroller.scrollTop;
    const below = endTop - layout.selBarGap;
    const above = startTop - barH - layout.selBarGap; // 兜底：贴选区首行上方
    const viewBottom = scroller.scrollTop + scroller.clientHeight;
    const top =
      below + barH <= viewBottom
        ? Math.max(layout.selBarMinGap, below)
        : Math.max(layout.selBarMinGap, above);
    selBar = {
      top,
      left: Math.max(layout.selBarMinLeft, start.left - srect.left),
      from,
      to,
      chars: text.trim().length,
    };
  }

  /**
   * B1 分流：小改（≤200 字且分流开关开）→ 就地浮层多轮打磨；大改进 → 暂存区候选。
   * 提交即生成第一版候选（浮层内继续打磨，满意才插入/替换）。
   */
  async function submitRewrite(): Promise<void> {
    if (!editor || !selBar || rewriting) return;
    const { from, to } = selBar;
    const original = captureSelection(editor.state.doc, from, to);
    if (original.trim().length < 2 || !work.current) {
      selBar = null;
      return;
    }
    if (settings.inlineSplit && original.length <= 200) {
      // 浮层定位（内容坐标，相对 scroller）：贴浮动条下缘，水平钳在 scroller 内，
      // 垂直钳在暂存抽屉（268px 高）之上——永不没入暂存区
      const popW = layout.selPopWidth;
      const popH = 420; // 浮层估算高（原文条 + 候选列表 + 底部输入），组件按实际高度自我钳位
      const x = Math.max(12, Math.min(selBar.left, scroller.clientWidth - popW - 12));
      const y = selBar.top + layout.selBarHeight + 6;
      const maxTop = Math.max(120, scroller.clientHeight - (candidates.drawerOpen ? 268 : 0) - popH - 8);
      popover = {
        x,
        y: Math.min(y, maxTop),
        maxTop,
        original,
        instruction: instruction.trim(),
      };
      instruction = '';
      return;
    }
    rewriting = true;
    rewriteChars = 0;
    const ok = await candidates.createFromSelection(
      work.current.relPath,
      original,
      instruction.trim(),
      (t) => (rewriteChars = t.length),
    );
    rewriting = false;
    if (ok) {
      selBar = null;
      instruction = '';
      editor.chain().setTextSelection(to).run(); // 收拢选区，删除线装饰接管视觉
    }
  }

  /** 采纳落地：original 唯一定位 → proposed 替换（单块且同块内联替换，多块整块替换）。 */
  function applyEdit(original: string, proposed: string): 'ok' | 'not-found' | 'ambiguous' {
    if (!editor) return 'not-found';
    const loc = locateUnique(editor.state.doc, original);
    if (!loc.ok) return loc.reason;
    const { from, to } = loc.range;
    const html = mdToHtml(proposed);
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    if (tmp.children.length === 1 && sameTextblock(from, to)) {
      editor
        .chain()
        .insertContentAt({ from, to }, tmp.firstElementChild?.innerHTML ?? proposed)
        .run();
    } else {
      editor.chain().insertContentAt({ from, to }, html).run();
    }
    return 'ok';
  }

  /** B1 插入其后：proposed 插入 original 之后（原文保留；多段插入则整段追加）。 */
  function insertAfter(original: string, proposed: string): 'ok' | 'not-found' | 'ambiguous' {
    if (!editor) return 'not-found';
    const loc = locateUnique(editor.state.doc, original);
    if (!loc.ok) return loc.reason;
    const html = mdToHtml(proposed);
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    if (tmp.children.length === 1 && sameTextblock(loc.range.from, loc.range.to)) {
      editor
        .chain()
        .insertContentAt(loc.range.to, tmp.firstElementChild?.innerHTML ?? proposed)
        .run();
    } else {
      editor.chain().insertContentAt(loc.range.to, html).run();
    }
    return 'ok';
  }

  /** from..to 是否落在同一个文本块内（决定行内替换还是整段替换）。 */
  function sameTextblock(from: number, to: number): boolean {
    if (!editor) return false;
    const doc = editor.state.doc;
    const resFrom = doc.resolve(from);
    const resTo = doc.resolve(Math.min(to, doc.content.size));
    return resFrom.depth > 0 && resFrom.sameParent(resTo) && resFrom.parent.isTextblock;
  }

  function jumpToScene(title: string): void {
    if (!editor) return;
    let found = false;
    editor.state.doc.descendants((node, pos) => {
      if (found) return false;
      if (node.type.name === 'heading' && node.textContent.trim() === title) {
        editor!.chain().setTextSelection(pos + node.nodeSize - 1).run();
        found = true;
        return false;
      }
      return true;
    });
    if (found) {
      // DOM 级滚动（挂载早期 PM scrollIntoView 不可靠），下一帧执行让布局先就位
      requestAnimationFrame(() => {
        const el = [...host.querySelectorAll('h1, h2, h3')].find(
          (h) => h.textContent?.trim() === title,
        );
        el?.scrollIntoView({ block: 'start' });
      });
    }
  }

  // ---------- B5 章头 ----------
  const cur = $derived(work.current);
  const fmStatus = $derived(typeof cur?.frontmatter?.status === 'string' ? cur.frontmatter.status : undefined);
  const fmPov = $derived(typeof cur?.frontmatter?.pov === 'string' ? cur.frontmatter.pov : undefined);
  const fmTags = $derived(
    Array.isArray(cur?.frontmatter?.tags)
      ? (cur.frontmatter.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : typeof cur?.frontmatter?.tags === 'string'
        ? [cur.frontmatter.tags]
        : [],
  );
  const goal = $derived(work.currentGoal());
  const wordCount = $derived(work.findChapter(work.current?.relPath ?? '')?.wordCount ?? 0);
  const goalRatio = $derived(goal ? Math.min(1, wordCount / goal) : null);
</script>

<div class="scroller" bind:this={scroller}>
  <div class="column">
    {#if cur}
      <div class="chapter-head">
        <h1 class="chapter-title">{cur.title}</h1>
        <div class="chapter-meta">
          {#if fmStatus}
            <span class="pill status"><i class="dot" style:background={statusVar(fmStatus)}></i>{fmStatus}</span>
          {/if}
          {#if fmPov}<span class="pill">POV · {fmPov}</span>{/if}
          {#each fmTags as t (t)}<span class="pill">{t}</span>{/each}
          {#if goal}
            <span class="goal-wrap">
              <span class="goal-bar"><i style:width={`${(goalRatio! * 100).toFixed(1)}%`}></i></span>
              <span class="goal-num">{wordCount.toLocaleString('zh-CN')} / {goal.toLocaleString('zh-CN')} 字(B5)</span>
            </span>
          {/if}
        </div>
      </div>
    {/if}
    <div class="prose" bind:this={host}></div>
  </div>

  {#if selBar && !popover}
    <div
      class="selbar"
      style:top="{selBar.top}px"
      style:left="{selBar.left}px"
      onmousedown={(e) => {
        // 只拦非输入元素的 mousedown，避免点击输入框时选区被 PM 清掉；输入框/按钮可正常聚焦
        if (!(e.target as HTMLElement).closest('input, button, textarea')) e.preventDefault();
      }}
      role="toolbar"
      aria-label="选区 AI 改写"
      tabindex="-1"
    >
      {#if rewriting}
        <span class="progress">AI 改写中…{rewriteChars > 0 ? `已生成 ${rewriteChars} 字` : ''}</span>
      {:else}
        <span class="picked">已选 {selBar.chars} 字</span>
        <input
          bind:value={instruction}
          placeholder="改写指令（如：更紧张一点；空=润色）"
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submitRewrite();
            }
          }}
        />
        <button onclick={() => void submitRewrite()}>改写</button>
      {/if}
    </div>
  {/if}

  {#if popover}
    <SelectionPopover
      x={popover.x}
      y={popover.y}
      maxTop={popover.maxTop}
      original={popover.original}
      chapter={cur?.relPath ?? ''}
      initialInstruction={popover.instruction}
      onClose={() => (popover = null)}
    />
  {/if}
</div>

<style>
  .scroller {
    height: 100%;
    overflow-y: auto;
    position: relative;
  }
  .column {
    max-width: calc(var(--body-maxwidth) + 96px);
    margin: 0 auto;
    padding: 48px 48px 45vh; /* 底部留白让末行也能上提到 42% */
  }
  .chapter-head {
    margin-bottom: 34px;
  }
  .chapter-title {
    font-family: var(--body-font);
    font-size: 27px;
    font-weight: 700;
    letter-spacing: 0.14em;
    line-height: 1.5;
    margin: 0;
  }
  .chapter-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
    font-size: 11.5px;
    color: var(--muted);
    flex-wrap: wrap;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 20px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 10px;
    font-size: 11px;
  }
  .pill .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
  }
  .pill.status {
    border-color: color-mix(in srgb, var(--status-polish) 40%, var(--line));
    color: var(--status-polish);
  }
  .goal-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 160px;
    max-width: 300px;
  }
  .goal-bar {
    flex: 1;
    height: 3px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--muted) 16%, transparent);
    overflow: hidden;
  }
  .goal-bar i {
    display: block;
    height: 100%;
    background: var(--status-polish);
    border-radius: 2px;
    transition: width 0.6s var(--ease-fold);
  }
  .goal-num {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .prose {
    /* 行高按 --body-line-px 派生（默认 17px×1.75=30，theme.ts 的 lineHeightPx 派生），
       选区浮动条按此卡行间隙定位；改字号/行高由 applyTheme 自动重算 --body-line-px。 */
    font-family: var(--body-font);
    font-size: var(--body-size);
    line-height: var(--body-leading);
    color: var(--ink);
    outline: none;
  }
  .prose :global(.ProseMirror) {
    outline: none;
    min-height: 40vh;
  }
  .prose :global(.ProseMirror p) {
    margin: 0 0 0.4em;
    text-indent: var(--body-indent);
  }
  .prose :global(.ProseMirror h1),
  .prose :global(.ProseMirror h2),
  .prose :global(.ProseMirror h3) {
    text-indent: 0;
    font-weight: 600;
    margin: 1.6em 0 0.6em;
  }
  .prose :global(.ProseMirror h3) {
    font-size: 1.05em;
    color: var(--muted);
  }

  /* —— 暂存候选内联装饰：原文删除线，建议文本建议色插入，尾带 ✓/× —— */
  .prose :global(.suggest-del) {
    text-decoration: line-through;
    text-decoration-color: var(--strike);
    text-decoration-thickness: 1px;
    color: var(--muted);
    background: color-mix(in srgb, var(--danger) 7%, transparent);
  }
  .prose :global(.suggest-widget) {
    white-space: normal;
    user-select: none;
  }
  .prose :global(.suggest-ins) {
    color: var(--accent);
    background: var(--suggest-bg);
    border-bottom: 1px solid var(--suggest-line);
    border-radius: 3px;
    padding: 0 2px;
  }
  .prose :global(.suggest-btn) {
    font-size: 11px;
    line-height: 1;
    padding: 1px 5px;
    margin-left: 4px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--panel);
    cursor: pointer;
    vertical-align: 2px;
  }
  .prose :global(.suggest-btn.accept) {
    color: var(--ok);
  }
  .prose :global(.suggest-btn.accept:hover) {
    border-color: var(--ok);
  }
  .prose :global(.suggest-btn.reject) {
    color: var(--danger);
  }
  .prose :global(.suggest-btn.reject:hover) {
    border-color: var(--danger);
  }

  /* —— 选区浮动条 —— */
  .selbar {
    position: absolute;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: var(--shadow-pop);
    font-family: var(--ui-font);
  }
  .selbar .picked {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }
  .selbar input {
    width: 240px;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 12px;
    background: var(--paper);
    color: var(--ink);
    outline: none;
  }
  .selbar input:focus {
    border-color: var(--accent);
  }
  .selbar button {
    background: var(--accent);
    color: var(--on-accent);
    font-size: 12px;
    padding: 4px 12px;
    border-radius: 6px;
    white-space: nowrap;
  }
  .selbar .progress {
    font-size: 12px;
    color: var(--accent);
    padding: 2px 6px;
  }
</style>
