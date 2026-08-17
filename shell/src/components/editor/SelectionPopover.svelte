<script lang="ts">
  // B1 多候选就地浮层：原文（删除线）+ 候选 tab/卡（选中者 accent 左缘）+ 底部打磨输入框。
  // 多轮打磨：指令再生成新版本（tab 递增）；满意才「插入其后 / 替换原文」；
  // 小改就地（≤200 字且分流开关开）走这里，大改进走暂存抽屉。
  // 关闭：× / Esc / 点浮层外（参照审批卡/面板现有模式）。
  import { onMount } from 'svelte';
  import { iconSvg } from '../../lib/icons.js';
  import { candidates } from '../../lib/candidates.svelte.js';
  import { snapshot } from '../../lib/snapshot.svelte.js';
  import { work } from '../../lib/work.svelte.js';

  interface Candidate {
    id: number;
    text: string;
    label: string;
  }

  interface Props {
    /** 相对 editor scroller 的定位。 */
    x: number;
    y: number;
    /** 垂直钳位上限（抽屉/底部留白之上）。 */
    maxTop: number;
    /** 选区原文（替换锚点）。 */
    original: string;
    chapter: string;
    /** 首次打磨指令（可为空=换一版）。 */
    initialInstruction: string;
    onClose: () => void;
  }
  let { x, y, maxTop, original, chapter, initialInstruction, onClose }: Props = $props();

  let rootEl = $state<HTMLDivElement | null>(null);

  let cands = $state<Candidate[]>([]);
  let active = $state(0);
  // svelte-ignore state_referenced_locally —— 浮层按打开瞬间的指令初始化一次（组件随浮层挂载/卸载）
  let instruction = $state(initialInstruction);
  let polishing = $state(false);
  let progress = $state(0);
  /** 流式打磨草稿：生成过程实时显示，完成态落候选卡（缺陷2修复）。 */
  let draft = $state('');
  let applying = $state(false);
  let seq = 0;

  // Esc 关浮层；click outside 落在 mousedown 阶段判断（输入框/按钮/浮层自身内吞掉）
  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onDocMouseDown = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (!t) return;
      if (rootEl?.contains(t)) return; // 浮层内：吞掉
      onClose();
    };
    window.addEventListener('keydown', onKey);
    // capture 阶段拦截，绕过编辑器内 mousedown 的 preventDefault；只对浮层外有效
    window.addEventListener('mousedown', onDocMouseDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDocMouseDown, true);
    };
  });

  // 打开即生成第一版（提交改写时已带首次指令；空指令=润色）
  $effect(() => {
    if (cands.length === 0 && !polishing) void polish();
  });

  /** 打磨：带指令=按指令出新版；空指令=换一版（与上一版风格/节奏明显不同）。 */
  async function polish(): Promise<void> {
    if (polishing) return;
    const ask = instruction.trim();
    const variant = ask
      ? ask
      : cands.length === 0
        ? '润色这段文字'
        : `换一种写法（第 ${cands.length + 1} 版），与上一版风格/节奏明显不同，保持原意`;
    polishing = true;
    progress = 0;
    draft = '';
    const text = await candidates.rewriteText(original, variant, (t) => {
      progress = t.length;
      draft = t; // 增量追加显示（30–50ms 批次）
    }, work.workDir);
    polishing = false;
    draft = '';
    if (text === null) return;
    seq += 1;
    cands = [...cands, { id: seq, text, label: `候选 ${cn(cands.length + 1)}` }];
    active = cands.length - 1;
    instruction = '';
  }

  function cn(n: number): string {
    return '一二三四五六七八九十'[n - 1] ?? String(n);
  }

  async function apply(mode: 'replace' | 'insert'): Promise<void> {
    const c = cands[active];
    if (!c || applying) return;
    applying = true;
    const r = mode === 'replace' ? work.applyEdit(original, c.text) : work.insertAfter(original, c.text);
    if (r === 'ok') {
      const saved = await work.saveCurrent(); // 满意才落地：替换 + 保存（B4 快照在 write_chapter 安全阀）
      onClose();
      if (saved) {
        void snapshot.showAdoptedToast(
          `已${mode === 'replace' ? '替换原文' : '插入其后'} · ${chapter.split('/').pop()?.replace(/\.md$/, '')}`,
          chapter,
        );
      }
    } else {
      work.error =
        r === 'no-editor' ? '编辑器未就绪' : r === 'ambiguous' ? '原文在本章多处出现，无法定位' : '原文已变动，找不到锚点';
    }
    applying = false;
  }

  // 定位钳位：垂直不没入暂存抽屉（抽屉开合 maxTop 需重算）。
  // 原型用 MutationObserver 监抽屉 class 触发重钳，这里用 $effect 监听 drawerOpen + 实际高度响应式重算，
  // 与浮层尺寸/抽屉状态同源，避免打开瞬间计算后抽屉开合盖住浮层。

  /** 抽屉开合后（268px）按浮层实际高度重算 maxTop。 */
  // svelte-ignore state_referenced_locally —— 初始值取自打开瞬间的 prop；后续变化由 $effect 重算覆写
  let liveMaxTop = $state(maxTop);
  $effect(() => {
    const drawerH = candidates.drawerOpen ? 268 : 0;
    const popH = rootEl?.offsetHeight || 380;
    const scroller = rootEl?.closest('.scroller') as HTMLElement | null;
    if (!scroller) {
      liveMaxTop = maxTop;
      return;
    }
    const max = Math.max(120, scroller.clientHeight - drawerH - popH - 8);
    liveMaxTop = Math.min(maxTop, max);
  });

  const effectiveTop = $derived(Math.min(y, liveMaxTop));
</script>

<div class="selpop" role="dialog" aria-label="AI 改写候选" tabindex="-1" bind:this={rootEl} style:left="{x}px" style:top="{effectiveTop}px" onmousedown={(e) => {
  // 只拦非输入元素的 mousedown（保住选区）；输入框/按钮正常聚焦
  if (!(e.target as HTMLElement).closest('input, button, textarea')) e.preventDefault();
}}>
  <div class="head">
    <span class="lbl">改写候选</span>
    <div class="tabs">
      {#each cands as c, i (c.id)}
        <button class="tab" class:on={active === i} onclick={() => (active = i)}>{c.label}</button>
      {/each}
      {#if cands.length === 0}
        <button class="tab">候选 一</button>
      {/if}
    </div>
    <button class="icon-btn" onclick={onClose} title="关闭浮层 (Esc)" aria-label="关闭浮层">{@html iconSvg('close', 14, 2)}</button>
  </div>

  <div class="src">
    <span class="lbl">原 文</span>
    <span class="txt">{original}</span>
  </div>

  <div class="cand-list">
    {#if cands.length === 0}
      <div class="cand empty">
        <div class="cand-tag"><span class="radio"></span><span>候选一 · 等待生成</span></div>
        <div class="cand-text muted">点「打磨」生成第一个候选；可多轮下指令再打磨，满意才插入/替换（B1）。</div>
      </div>
    {/if}
    {#each cands as c, i (c.id)}
      <div class="cand" class:on={active === i} role="button" tabindex="0" onclick={() => (active = i)} onkeydown={(e) => e.key === 'Enter' && (active = i)}>
        <div class="cand-tag"><span class="radio"></span><span>{c.label}{#if i === 0 && cands.length > 1} · 初版{/if}</span></div>
        <div class="cand-text">{c.text}</div>
      </div>
    {/each}
    {#if polishing}
      <div class="cand">
        <div class="cand-tag"><span class="pulse-dot"></span><span>AI 打磨中…{progress > 0 ? `已生成 ${progress} 字` : ''}</span></div>
        {#if draft}<div class="cand-text draft">{draft}</div>{/if}
      </div>
    {/if}
  </div>

  <div class="foot">
    <input
      bind:value={instruction}
      placeholder="继续下指令打磨，可多轮(B1)；空=换一版"
      onkeydown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void polish();
        }
      }}
      disabled={polishing}
    />
    <button class="btn" onclick={() => void polish()} disabled={polishing}>打磨</button>
    <button class="btn" onclick={() => void apply('insert')} disabled={cands.length === 0 || applying}>插入其后</button>
    <button class="btn primary" onclick={() => void apply('replace')} disabled={cands.length === 0 || applying}>替换原文</button>
  </div>
</div>

<style>
  .selpop {
    position: absolute;
    width: 580px;
    max-width: calc(100% - 24px);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: var(--shadow-pop);
    z-index: 40;
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 14px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
    color: var(--muted);
  }
  .lbl {
    letter-spacing: 0.15em;
    font-size: 10.5px;
    flex: none;
  }
  .tabs {
    display: flex;
    gap: 4px;
    flex: 1;
    flex-wrap: wrap;
  }
  .tab {
    height: 22px;
    padding: 0 10px;
    font-size: 11.5px;
    border-radius: 11px;
    border: 1px solid var(--line);
    color: var(--muted);
    transition: all var(--t-hover);
  }
  .tab.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .tab:not(.on):hover {
    border-color: var(--accent-line);
    color: var(--accent);
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
    flex: none;
  }
  .icon-btn:hover {
    background: color-mix(in srgb, var(--muted) 12%, transparent);
    color: var(--ink);
  }
  .src {
    padding: 8px 14px;
    font-size: 12px;
    color: var(--muted);
    border-bottom: 1px dashed var(--line);
    display: flex;
    gap: 8px;
    align-items: baseline;
    max-height: 96px;
    overflow-y: auto;
  }
  .src .lbl {
    flex: none;
    font-size: 10.5px;
    letter-spacing: 0.15em;
  }
  .src .txt {
    text-decoration: line-through;
    text-decoration-color: var(--strike);
  }
  .cand-list {
    max-height: 300px;
    overflow-y: auto;
  }
  .cand {
    padding: 11px 14px 11px 12px;
    border-left: 2px solid transparent;
    cursor: pointer;
    transition: background var(--t-hover), border-color var(--t-hover);
  }
  .cand + .cand {
    border-top: 1px solid var(--line);
  }
  .cand:hover {
    background: color-mix(in srgb, var(--muted) 5%, transparent);
  }
  .cand.on {
    border-left-color: var(--accent);
    background: var(--accent-soft);
  }
  .cand.empty {
    cursor: default;
  }
  .cand-tag {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 5px;
  }
  .radio {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 1px solid var(--muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .cand.on .radio {
    border-color: var(--accent);
  }
  .cand.on .radio::after {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
  .cand-text {
    font-family: var(--body-font);
    font-size: 14px;
    line-height: 1.75;
    white-space: pre-wrap;
  }
  /* 流式草稿：生成中文本高亮（完成态转正式候选卡） */
  .cand-text.draft {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 5%, transparent);
    border-radius: 5px;
    padding: 2px 6px;
  }
  .cand-text.muted {
    color: var(--muted);
    font-family: var(--ui-font);
    font-size: 12px;
  }
  .pulse-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
  .foot {
    border-top: 1px solid var(--line);
    padding: 9px 12px;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .foot input {
    flex: 1;
    height: 30px;
    padding: 0 10px;
    font-size: 12.5px;
    background: color-mix(in srgb, var(--muted) 7%, transparent);
    border: 1px solid transparent;
    border-radius: 6px;
    outline: none;
    transition: border-color var(--t-hover);
  }
  .foot input:focus {
    border-color: var(--accent-line);
    background: var(--panel);
  }
  .btn {
    height: 30px;
    padding: 0 13px;
    font-size: 12.5px;
    border-radius: 6px;
    border: 1px solid var(--line);
    transition: all var(--t-hover);
    white-space: nowrap;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--muted);
  }
  .btn:disabled {
    opacity: 0.4;
  }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .btn.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 88%, #000);
    border-color: transparent;
  }
</style>
