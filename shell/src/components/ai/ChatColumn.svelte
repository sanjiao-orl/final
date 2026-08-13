<script lang="ts">
  // 对话栏（B7/B8）：当前会话名（双击重命名）+ 消息流 + composer；
  // AI 直调工具在此列以工具状态行跟随（卡片详情在工具栏）。
  import { iconSvg } from '../../lib/icons.js';
  import { chat } from '../../lib/chat.svelte.js';
  import { work } from '../../lib/work.svelte.js';
  import { candidates } from '../../lib/candidates.svelte.js';

  let input = $state('');
  let listEl = $state<HTMLDivElement | null>(null);

  const cur = $derived(chat.sessions.find((s) => s.id === chat.sessionId));

  function send(): void {
    const text = input;
    input = '';
    void chat.send(text);
  }

  // 流式期间跟底
  $effect(() => {
    const el = listEl;
    if (el && chat.messages.length) {
      el.scrollTop = el.scrollHeight;
    }
  });

  function mountHint(): string {
    const scope = chat.scope;
    if (scope === '') return '无归属讨论：不挂在任何章上的话题';
    if (scope === 'work') return '作品根';
    if (scope.startsWith('vol:')) return `卷：${scope.slice(4)}`;
    if (scope.startsWith('ch:')) {
      const key = scope.slice(3);
      const node = work.findChapterById(key) ?? work.findChapter(key);
      return node ? `挂载：${node.title}` : '挂载：本章';
    }
    return `挂载：${scope}`;
  }
</script>

<div class="session-head">
  <div class="name-wrap">
    {#if chat.renamingId === cur?.id}
      <input
        class="name-input"
        bind:value={chat.renameDraft}
        onkeydown={(e) => {
          if (e.key === 'Enter') chat.commitRename();
          if (e.key === 'Escape') chat.cancelRename();
        }}
        onblur={() => chat.commitRename()}
      />
    {:else}
      <span
        class="name"
        role="button"
        tabindex="0"
        ondblclick={() => cur && chat.startRename(cur.id)}
        onkeydown={(e) => e.key === 'Enter' && cur && chat.startRename(cur.id)}
        title="双击重命名(B7)"
      >{cur ? chat.sessionTitle(cur) : '新对话'}</span
      >
    {/if}
    <span class="mount">{mountHint()}</span>
  </div>
  <span class="ops">
    <button class="icon-btn" title="归档(B7)" onclick={() => cur && chat.archiveSession(cur.id)} aria-label="归档会话">{@html iconSvg('archive', 13)}</button>
    <button class="icon-btn" title="新建会话(挂载当前层级)" onclick={() => chat.newSession()} aria-label="新建会话">{@html iconSvg('plus', 14, 2)}</button>
  </span>
</div>

<div class="messages" bind:this={listEl}>
  {#if chat.messages.length === 0}
    <p class="hint">
      {chat.scope === ''
        ? '无归属讨论：大纲、设定、灵感、全书方向。助手会经工具读真实文件。'
        : `当前挂载：${chat.scopeLabel()}。围绕这一层的问题、方向、改写思路。`}
    </p>
  {/if}
  {#each chat.messages as m, i (i)}
    <div class="msg {m.role}">
      {#if m.role === 'assistant' && m.content !== ''}
        <span class="who">AI · {chat.scopeLabel()}{#if chat.abortedLastStream && i === chat.messages.length - 1}<i class="aborted">已中断</i>{/if}</span>
      {/if}
      {#if m.content !== ''}<div class="bubble">{m.content}</div>{/if}
      {#each m.tools ?? [] as t (t.id)}
        <div class="tool" class:pending={t.state === 'pending'} class:done={t.state === 'done'} class:rejected={t.state === 'rejected'}>
          {t.state === 'pending'
            ? `${t.name} 挂起待审批`
            : t.state === 'rejected'
              ? `${t.name} 已拒绝`
              : t.state === 'running'
                ? `${t.name} 调用中…`
                : `${t.name} ✓`}
        </div>
      {/each}
      {#if m.role === 'error'}<span class="err">{m.content}</span>{/if}
    </div>
  {/each}
  {#if chat.streaming}
    <div class="msg assistant muted">…</div>
  {/if}
  {#if candidates.pendingCount > 0}
    <div class="staged-note" role="button" tabindex="0" onclick={() => candidates.toggleDrawer()} onkeydown={(e) => e.key === "Enter" && candidates.toggleDrawer()}>
      {@html iconSvg('drawer', 13)}
      产出 {candidates.pendingCount} 条改写候选 → 已送暂存区，点击前往裁决
    </div>
  {/if}
</div>

<div class="composer">
  <div class="box">
    <textarea
      placeholder={`对${chat.scopeLabel()}下指令…(Enter 发送, Shift+Enter 换行)`}
      bind:value={input}
      onkeydown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      }}
    ></textarea>
    <div class="bar">
      <span class="hint">Enter 发送 · Shift+Enter 换行</span>
      {#if chat.streaming}
        <button class="stop" onclick={() => chat.abortStream()} aria-label="停止" title="停止生成（已收内容会保留，已中断）">{@html iconSvg('close', 12, 2)} 停止</button>
      {:else}
        <button class="send" onclick={send} disabled={chat.streaming || input.trim() === ''} aria-label="发送">{@html iconSvg('spark', 13, 2)}</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .session-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }
  .name-wrap {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .name {
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: text;
    padding: 2px 4px;
    border-radius: 4px;
  }
  .name:hover {
    background: color-mix(in srgb, var(--muted) 8%, transparent);
  }
  .mount {
    font-size: 10.5px;
    color: var(--muted);
    padding: 0 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name-input {
    width: 100%;
    height: 24px;
    padding: 0 6px;
    font-size: 12.5px;
    border: 1px solid var(--accent-line);
    border-radius: 4px;
    background: var(--panel);
    outline: none;
  }
  .ops {
    display: flex;
    gap: 2px;
    flex: none;
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
  .messages {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }
  .hint {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.7;
  }
  .msg {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .msg .who {
    font-size: 10.5px;
    letter-spacing: 0.15em;
    color: var(--muted);
  }
  .msg .who .aborted {
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 7px;
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
    font-style: normal;
    letter-spacing: 0.06em;
  }
  .msg-user .bubble {
    align-self: flex-end;
    background: color-mix(in srgb, var(--muted) 10%, transparent);
    border-radius: 10px 10px 3px 10px;
    padding: 8px 11px;
    font-size: 12.5px;
    line-height: 1.65;
    max-width: 88%;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg-ai .bubble {
    border-left: 2px solid var(--accent-line);
    padding: 2px 0 2px 11px;
    font-size: 12.5px;
    line-height: 1.75;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .msg.muted {
    color: var(--muted);
  }
  .err {
    color: var(--danger);
    font-size: 12px;
    border: 1px solid var(--danger);
    border-radius: 6px;
    padding: 6px 9px;
  }
  .tool {
    align-self: flex-start;
    font-size: 11px;
    color: var(--muted);
    padding: 3px 8px;
    border-radius: 9px;
    border: 1px solid var(--line);
  }
  .tool.done {
    color: var(--ok);
    border-color: color-mix(in srgb, var(--ok) 35%, var(--line));
  }
  .tool.pending {
    color: var(--status-draft);
    border-color: color-mix(in srgb, var(--status-draft) 40%, var(--line));
    background: var(--warn-bg);
  }
  .tool.rejected {
    color: var(--danger);
  }
  .staged-note {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border: 1px dashed var(--suggest-line);
    background: var(--suggest-bg);
    border-radius: 7px;
    font-size: 11.5px;
    color: var(--ok);
    cursor: pointer;
    transition: border-color var(--t-hover);
  }
  .staged-note:hover {
    border-color: var(--ok);
  }
  .composer {
    border-top: 1px solid var(--line);
    padding: 10px 0 0;
  }
  .box {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
    transition: border-color var(--t-hover);
  }
  .box:focus-within {
    border-color: var(--accent-line);
  }
  textarea {
    width: 100%;
    border: none;
    outline: none;
    resize: none;
    background: transparent;
    padding: 9px 11px 4px;
    font-size: 12.5px;
    line-height: 1.6;
    min-height: 58px;
    display: block;
  }
  .bar {
    display: flex;
    align-items: center;
    padding: 4px 8px 7px;
    gap: 6px;
  }
  .hint {
    flex: 1;
    font-size: 10.5px;
    color: var(--muted);
  }
  .send {
    width: 26px;
    height: 26px;
    border-radius: 6px;
    background: var(--accent);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background var(--t-hover);
  }
  .send:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 85%, #000);
  }
  .send:disabled {
    opacity: 0.4;
  }
  .stop {
    height: 26px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid var(--danger);
    background: transparent;
    color: var(--danger);
    font-size: 11.5px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition: background var(--t-hover);
  }
  .stop:hover {
    background: color-mix(in srgb, var(--danger) 8%, transparent);
  }
</style>
