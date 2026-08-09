<script lang="ts">
  // AI 面板（第 3 周）：双讨论存区——无归属讨论 / 章节内讨论（跟随当前打开章）。
  // 会话持久化在 core，重启/切换后从列表恢复；工具行按调用 id 跟踪状态。
  import { chat } from '../lib/chat.svelte.js';
  import { work } from '../lib/work.svelte.js';

  let tab = $state<'work' | 'chapter'>('work');
  let input = $state('');
  let listEl = $state<HTMLDivElement | null>(null);

  // 本章 tab：scope 跟随当前打开章；无归属 tab：scope=''
  $effect(() => {
    const rel = work.current?.relPath;
    if (tab === 'chapter') {
      if (rel) void chat.setScope(rel);
    }
  });

  function switchTab(t: 'work' | 'chapter'): void {
    tab = t;
    if (t === 'work') void chat.setScope('');
    else if (work.current) void chat.setScope(work.current.relPath);
  }

  function send(): void {
    const text = input;
    input = '';
    void chat.send(text);
  }

  $effect(() => {
    // 流式期间跟底
    if (listEl && chat.messages.length) listEl.scrollTop = listEl.scrollHeight;
  });
</script>

<section>
  <div class="tabs" role="tablist">
    <button class:active={tab === 'work'} onclick={() => switchTab('work')} role="tab">无归属</button>
    <button
      class:active={tab === 'chapter'}
      onclick={() => switchTab('chapter')}
      disabled={!work.current}
      title={work.current ? work.current.title : '先打开一章'}
      role="tab">本章</button
    >
  </div>

  <div class="sessbar">
    <select
      value={chat.sessionId ?? ''}
      onchange={(e) => {
        const v = e.currentTarget.value;
        if (v === '') chat.newSession();
        else void chat.openSession(v);
      }}
      aria-label="讨论会话"
    >
      <option value="">＋ 新讨论</option>
      {#each chat.sessions as s (s.id)}
        <option value={s.id}>{s.title || '（未命名）'}</option>
      {/each}
    </select>
  </div>

  <div class="messages" bind:this={listEl}>
    {#if tab === 'chapter' && !work.current}
      <p class="hint">章节内讨论挂在打开的章上；先从左侧打开一章。</p>
    {:else if chat.messages.length === 0}
      <p class="hint">
        {tab === 'chapter'
          ? '本章讨论：围绕当前章的问题、方向、改写思路。助手会经工具读真实文件。'
          : '无归属讨论：不挂在任何章上的话题——大纲、设定、灵感、全书方向。'}
      </p>
    {/if}
    {#each chat.messages as m, i (i)}
      <div class="msg {m.role}">
        {m.content}
        {#each m.tools ?? [] as t (t.id)}
          <div class="tool" class:done={t.done}>{t.done ? `${t.name} ✓` : `${t.name} 调用中…`}</div>
        {/each}
      </div>
    {/each}
    {#if chat.streaming}
      <div class="msg assistant muted">…</div>
    {/if}
  </div>

  <div class="composer">
    <textarea
      bind:value={input}
      rows="3"
      placeholder="Enter 发送 / Shift+Enter 换行"
      onkeydown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      }}
    ></textarea>
    <button
      onclick={send}
      disabled={chat.streaming || input.trim() === '' || (tab === 'chapter' && !work.current)}
      >发送</button
    >
  </div>
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--panel);
  }
  .tabs {
    display: flex;
    border-bottom: 1px solid var(--line);
    flex: none;
  }
  .tabs button {
    flex: 1;
    padding: 9px 0;
    font-size: 13px;
    color: var(--muted);
    border-bottom: 2px solid transparent;
  }
  .tabs button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
  .tabs button:disabled {
    opacity: 0.4;
  }
  .sessbar {
    padding: 8px 10px;
    border-bottom: 1px solid var(--line);
    flex: none;
  }
  .sessbar select {
    width: 100%;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 6px;
    font-size: 12px;
    background: var(--paper);
    color: var(--ink);
    outline: none;
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .hint {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.7;
  }
  .msg {
    max-width: 92%;
    padding: 7px 11px;
    border-radius: 9px;
    font-size: 13px;
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg.user {
    align-self: flex-end;
    background: var(--accent);
    color: #fff;
  }
  .msg.assistant {
    align-self: flex-start;
    background: var(--paper);
    border: 1px solid var(--line);
  }
  .msg.error {
    align-self: flex-start;
    color: var(--danger);
    border: 1px solid var(--danger);
    font-size: 12px;
  }
  .msg.muted {
    color: var(--muted);
  }
  .tool {
    margin-top: 5px;
    font-size: 11px;
    color: var(--muted);
  }
  .tool.done {
    color: var(--ok);
  }
  .composer {
    display: flex;
    gap: 6px;
    padding: 10px;
    border-top: 1px solid var(--line);
  }
  textarea {
    flex: 1;
    resize: none;
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 6px 9px;
    font: inherit;
    font-size: 13px;
    background: var(--paper);
    color: var(--ink);
    outline: none;
  }
  textarea:focus {
    border-color: var(--accent);
  }
  .composer button {
    background: var(--accent);
    color: #fff;
    border-radius: 7px;
    padding: 0 14px;
  }
  .composer button:disabled {
    opacity: 0.45;
  }
</style>
