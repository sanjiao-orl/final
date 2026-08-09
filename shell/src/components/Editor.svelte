<script lang="ts">
  // 编辑器：TipTap 承载正文（HTML ↔ md 桥在 lib/markdown.ts），打字机滚动锁 42%，
  // 场景跳转按标题文本定位；第 3 周：选区浮动条（AI 改写）+ 暂存候选内联删除线装饰。
  // 序列化/替换入口注册到 work store（保存取 md、采纳候选做文本替换）。
  import { onDestroy, onMount } from 'svelte';
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import { htmlToMd, mdToHtml } from '../lib/markdown.js';
  import { captureSelection, locateUnique } from '../lib/pm-search.js';
  import { refreshSuggests, Suggest } from '../lib/suggest.js';
  import { candidates } from '../lib/candidates.svelte.js';
  import { work } from '../lib/work.svelte.js';
  import { layout } from '../theme.js';

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
    if (!editor || rewriting) return;
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
    const barH = 38; // 浮动条估算高度
    const startTop = start.top - srect.top + scroller.scrollTop;
    const endTop = end.top - srect.top + scroller.scrollTop;
    // 主路径：浮动条 [行顶-8, 行顶+30] 恰好卡在行间隙（行高≈30、字形区 [+6.5, +23.5]），
    // 只覆盖选区行自身（高亮无感），与相邻行字形零重叠。
    const below = endTop - 8;
    const above = startTop - barH - 8; // 兜底：贴选区首行上方
    const viewBottom = scroller.scrollTop + scroller.clientHeight;
    const top =
      below + barH <= viewBottom ? Math.max(4, below) : Math.max(4, above);
    selBar = {
      top,
      left: Math.max(8, start.left - srect.left),
      from,
      to,
      chars: text.trim().length,
    };
  }

  /** 浮动条提交：当前选区原文 + 指令 → 暂存区候选（流式进度实时显示）。 */
  async function submitRewrite(): Promise<void> {
    if (!editor || !selBar || rewriting) return;
    const { from, to } = selBar;
    const original = captureSelection(editor.state.doc, from, to);
    if (original.trim().length < 2 || !work.current) {
      selBar = null;
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
</script>

<div class="scroller" bind:this={scroller}>
  <div class="column">
    <div class="prose" bind:this={host}></div>
  </div>
  {#if selBar}
    <div
      class="selbar"
      style:top="{selBar.top}px"
      style:left="{selBar.left}px"
      onmousedown={(e) => e.preventDefault()}
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
</div>

<style>
  .scroller {
    height: 100%;
    overflow-y: auto;
    position: relative;
  }
  .column {
    max-width: var(--body-maxwidth);
    margin: 0 auto;
    padding: 28px 36px 45vh; /* 底部留白让末行也能上提到 42% */
  }
  .prose {
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
    text-decoration-color: var(--danger);
    text-decoration-thickness: 1.5px;
    color: var(--muted);
    background: color-mix(in srgb, var(--danger) 7%, transparent);
  }
  .prose :global(.suggest-widget) {
    white-space: normal;
    user-select: none;
  }
  .prose :global(.suggest-ins) {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 9%, transparent);
    border-bottom: 1px dashed var(--accent);
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
    box-shadow: 0 4px 18px rgb(0 0 0 / 0.14);
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
    color: #fff;
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
