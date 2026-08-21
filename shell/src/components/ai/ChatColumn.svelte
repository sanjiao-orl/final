<script lang="ts">
  // 对话栏（D2 · v4）：B7/B8 会话名（双击重命名）+ 消息流 + composer；
  // D2.1 assistant 气泡 marked 渲染 markdown（{@html} 输出——本地单用户 BYOK,信任面已记入方案）；
  // D2.2 工具 chip 堆叠 → 一行摘要「N 个工具调用 · 查看」+ ui.showCol('tools') + chat.focusToolsGroupKey 跳转；
  // D2.3 仅在接近底部(40px)时跟底，用户上翻即停；
  // D2.5 流式中气泡末尾 ▎ 光标 + "正在调用 XX" 指示；40ms 批次机制不动（0002 决策）。
  import { marked } from 'marked';
  import { iconSvg } from '../../lib/icons.js';
  import { chat } from '../../lib/chat.svelte.js';
  import { ui } from '../../lib/ui.svelte.js';
  import { work } from '../../lib/work.svelte.js';
  import { candidates } from '../../lib/candidates.svelte.js';
  import { collideParse } from '../../lib/collide-parse.js';
  import { collideVar } from '../../theme.js';
  import { splitLeadingQuote } from '../../lib/bridge.svelte.js';

  let listEl = $state<HTMLDivElement | null>(null);

  const cur = $derived(chat.sessions.find((s) => s.id === chat.sessionId));

  // 任务1（反馈#1）：composer 草稿绑 chat store 的 draftMap，关栏/切存区不再丢未发送文字。
  // 键与 store 共用 chat.currentDraftKey()：有会话挂 session:<id>，无会话挂 scope:<scope>。
  function send(): void {
    const key = chat.currentDraftKey();
    const text = chat.getDraft(key);
    if (!text.trim()) return;
    chat.setDraft(key, ''); // 立即清输入框（store 侧发送成功后兜底再清，失败则保留供重发）
    void chat.send(text);
  }

  let expandedQuotes = $state<Record<number, boolean>>({});
  function toggleQuote(i: number): void {
    expandedQuotes[i] = !expandedQuotes[i];
  }

  // D2.3：仅当用户已接近底部时才跟底；上翻阅读旧文不再被强行拉回。
  let stickToBottom = $state(true);
  function onScroll(e: Event): void {
    const el = e.currentTarget as HTMLDivElement;
    stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
  }
  $effect(() => {
    // 订阅消息内容变化（流式 delta / 工具行追加 / 错误插入都会触发）
    const _len = chat.messages.length;
    const _stream = chat.streaming;
    const _contentSig = chat.messages.map((m) => m.content.length).join(',');
    const el = listEl;
    if (!el) return;
    if (stickToBottom) el.scrollTop = el.scrollHeight;
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

  // D2.1 markdown 渲染：assistant 气泡用 marked 转 HTML，{@html} 输出。
  // 本地单用户 BYOK 信任面（v4 方案 §三 D2）—— 不引入 DOMPurify。
  function renderAiHtml(content: string): string {
    return marked.parse(content, { async: false, gfm: true }) as string;
  }

  // D2.5：光标/「正在调用」定位到流式占位消息——store 持有占位下标（send 时记录），
  // 直接读它，避免 onError 推错误气泡后把光标标到错误行。
  // （streamingIdx 由 store 维护：非流式/已结束为 -1）

  /** 当前消息是否有未完成工具（running/pending）—— 摘要行脉冲点 + "正在调用"提示用。 */
  function hasPending(tools: ChatMsgTools): boolean {
    return tools.some((t) => t.state === 'running' || t.state === 'pending');
  }
  /** 取该消息最后一个未完成工具的名字（"正在调用 XX"）；无返回 null。 */
  function streamingToolName(tools: ChatMsgTools): string | null {
    for (let i = tools.length - 1; i >= 0; i--) {
      const t = tools[i]!;
      if (t.state === 'running' || t.state === 'pending') return t.name;
    }
    return null;
  }
  type ChatMsgTools = NonNullable<(typeof chat.messages)[number]['tools']>;

  /** D2.2 摘要跳转：ui.showCol('tools') + 标 focusToolsGroupKey（下标字符串）。 */
  function jumpToTools(msgIndex: number): void {
    chat.focusToolsGroupKey = String(msgIndex);
    ui.showCol('tools');
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

<div class="messages" bind:this={listEl} onscroll={onScroll}>
  {#if chat.messages.length === 0}
    <p class="hint">
      {chat.scope === ''
        ? '无归属讨论：大纲、设定、灵感、全书方向。助手会经工具读真实文件。例：「帮我把前三章的伏笔理一遍」'
        : `当前挂载：${chat.scopeLabel()}。围绕这一层的问题、方向、改写思路。例：「这一章节奏拖了，给个收紧方案」`}
    </p>
  {/if}
  {#each chat.messages as m, i (i)}
    <div class="msg {m.role}">
      {#if m.role === 'assistant' && m.content !== ''}
        <span class="who">AI · {chat.scopeLabel()}{#if chat.abortedLastStream && i === chat.messages.length - 1}<i class="aborted">已中断</i>{/if}</span>
      {/if}
      {#if m.content !== ''}
        <div class="bubble">
          {#if m.role === 'assistant'}
            {@const secs = collideParse(m.content)}
            {#if secs}
              {#each secs as sec (sec.sec)}
                <div class="collide-sec" style:--sec-color={collideVar(sec.sec)}>
                  {@html marked.parse(sec.md, { async: false, gfm: true })}
                </div>
              {/each}
            {:else}
              {@html renderAiHtml(m.content)}
            {/if}
            {#if i === chat.streamingIdx && chat.streaming}<span class="cursor" aria-hidden="true">▍</span>{/if}
          {:else if m.role === 'user'}
            {@const parts = splitLeadingQuote(m.content)}
            {#if parts.quote}
              <button class="quote-message" class:expanded={expandedQuotes[i]} onclick={() => toggleQuote(i)} aria-expanded={expandedQuotes[i]}>
                <span>{expandedQuotes[i] ? parts.quote : parts.quote.split('\n').slice(0, 3).join('\n')}{!expandedQuotes[i] && parts.quote.split('\n').length > 3 ? '…' : ''}</span>
              </button>
            {/if}
            {#if parts.body}<div class="quote-body">{parts.body}</div>{/if}
          {:else}
            {m.content}
          {/if}
        </div>
      {/if}
      {#if m.role === 'assistant' && m.tools && m.tools.length > 0}
        <button class="tool-summary" class:has-pending={hasPending(m.tools)} onclick={() => jumpToTools(i)} title="切到工具面板并定位到该轮">
          {#if hasPending(m.tools)}<i class="pulse-dot"></i>{/if}
          {m.tools.length} 个工具调用 · 查看
          {#if streamingToolName(m.tools) && i === chat.streamingIdx}
            <span class="running-tool">正在调用 {streamingToolName(m.tools)}</span>
          {/if}
        </button>
      {/if}
      {#if m.role === 'error'}<span class="err">{m.content}</span>{/if}
    </div>
  {/each}
  {#if candidates.pendingCount > 0}
    <div class="staged-note" role="button" tabindex="0" onclick={() => candidates.openStaging()} onkeydown={(e) => e.key === "Enter" && candidates.openStaging()}>
      {@html iconSvg('drawer', 13)}
      产出 {candidates.pendingCount} 条改写候选 → 已送暂存区，点击前往裁决
    </div>
  {/if}
</div>

<div class="composer">
  <div class="box">
    {#if chat.getQuote(chat.currentDraftKey())}
      <div class="quote-chip"><span>📎 {chat.getQuote(chat.currentDraftKey())?.label}</span><button onclick={() => chat.setQuote(chat.currentDraftKey(), null)} aria-label="移除引用">×</button></div>
    {/if}
    <textarea
      placeholder={`对${chat.scopeLabel()}下指令…(Enter 发送, Shift+Enter 换行)`}
      value={chat.getDraft(chat.currentDraftKey())}
      oninput={(e) => chat.setDraft(chat.currentDraftKey(), e.currentTarget.value)}
      onkeydown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      }}
    ></textarea>
    <div class="bar">
      <button
        class="tier"
        class:cheap={chat.tier === 'background'}
        onclick={() => chat.setTier(chat.tier === 'writing' ? 'background' : 'writing')}
        title={chat.tier === 'writing' ? '当前：写作档（主笔模型）· 点击切到背景档' : '当前：背景档（便宜模型，杂活/整理用）· 点击切回写作档'}
      >
        {chat.tier === 'writing' ? '写作档' : '背景档'}
      </button>
      <button
        class="tier collide"
        class:on={chat.collide}
        onclick={() => chat.setCollide(!chat.collide)}
        title={chat.collide ? '当前：碰撞模式（方案/漏洞/反方/裁决）· 点击关闭' : '碰撞模式：正反交锋出结构化方案（方案/漏洞/反方/裁决）· 点击开启'}
      >
        {chat.collide ? '碰撞·开' : '碰撞'}
      </button>
      <span class="hint">Enter 发送 · Shift+Enter 换行</span>
      {#if chat.streaming}
        <button class="stop" onclick={() => chat.abortStream()} aria-label="停止" title="停止生成（已收内容会保留，已中断）">{@html iconSvg('close', 12, 2)} 停止</button>
      {:else}
        <button class="send" onclick={send} disabled={chat.streaming || chat.getDraft(chat.currentDraftKey()).trim() === ''} aria-label="发送">{@html iconSvg('spark', 13, 2)}</button>
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
    word-break: break-word;
  }
  /* 碰撞模式（批一③）四节着色：左边框 + 节标题色随 --sec-color（collideVar 注入）。 */
  .msg-ai .bubble :global(.collide-sec) {
    margin: 0.6em 0 0.9em;
    padding-left: 10px;
    border-left: 2px solid var(--sec-color);
  }
  .msg-ai .bubble :global(.collide-sec:first-child) {
    margin-top: 0;
  }
  .msg-ai .bubble :global(.collide-sec h2) {
    color: var(--sec-color);
  }
  /* D2.1：assistant 气泡内 markdown 基础排版（继承正文字体）。 */
  .msg-ai .bubble :global(h1),
  .msg-ai .bubble :global(h2),
  .msg-ai .bubble :global(h3),
  .msg-ai .bubble :global(h4) {
    font-family: var(--body-font);
    font-weight: 600;
    line-height: 1.4;
    margin: 0.6em 0 0.3em;
    text-indent: 0;
  }
  .msg-ai .bubble :global(h1) { font-size: 1.25em; }
  .msg-ai .bubble :global(h2) { font-size: 1.15em; }
  .msg-ai .bubble :global(h3) { font-size: 1.05em; }
  .msg-ai .bubble :global(h4) { font-size: 1em; }
  .msg-ai .bubble :global(p) {
    margin: 0 0 0.4em;
    text-indent: 0;
  }
  .msg-ai .bubble :global(ul),
  .msg-ai .bubble :global(ol) {
    margin: 0 0 0.4em;
    padding-left: 1.5em;
  }
  .msg-ai .bubble :global(li) {
    margin: 0 0 0.15em;
  }
  .msg-ai .bubble :global(a) {
    color: var(--accent);
    text-decoration: underline;
  }
  /* D2.1：行内 code 用等宽 + 底色小块；pre 代码块走预格式滚动区。 */
  .msg-ai .bubble :global(code) {
    font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace;
    font-size: 0.92em;
    padding: 1px 5px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--muted) 14%, transparent);
    color: var(--ink);
  }
  .msg-ai .bubble :global(pre) {
    font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace;
    font-size: 0.92em;
    line-height: 1.55;
    margin: 0 0 0.5em;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--muted) 8%, var(--paper));
    border: 1px solid var(--line);
    border-radius: 5px;
    overflow-x: auto;
  }
  .msg-ai .bubble :global(pre code) {
    padding: 0;
    background: transparent;
    border-radius: 0;
    color: inherit;
  }
  .msg-ai .bubble :global(blockquote) {
    margin: 0 0 0.4em;
    padding: 2px 10px;
    border-left: 3px solid var(--line);
    color: var(--muted);
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
  /* D2.5：流式中气泡末尾 ▎ 光标（闪烁）。 */
  .cursor {
    display: inline-block;
    margin-left: 1px;
    animation: cursor-blink 1s steps(2, end) infinite;
    color: var(--accent);
  }
  @keyframes cursor-blink {
    0%, 50% { opacity: 1; }
    50.01%, 100% { opacity: 0; }
  }
  /* D2.2：工具调用摘要行（替代原 chip 堆叠）。 */
  .tool-summary {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--muted);
    padding: 4px 10px;
    border-radius: 9px;
    border: 1px solid var(--line);
    background: var(--paper);
    cursor: pointer;
    transition: all var(--t-hover);
    text-align: left;
    line-height: 1.5;
  }
  .tool-summary:hover {
    border-color: var(--accent-line);
    color: var(--ink);
  }
  .tool-summary.has-pending {
    border-color: color-mix(in srgb, var(--status-draft) 40%, var(--line));
    background: var(--warn-bg);
    color: var(--ink);
  }
  .tool-summary .pulse-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--status-draft);
    animation: pulse 1.5s ease-in-out infinite;
    flex: none;
  }
  .tool-summary .running-tool {
    margin-left: 4px;
    padding-left: 6px;
    border-left: 1px solid var(--line);
    color: var(--accent);
    font-weight: 500;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
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
  .quote-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 7px 8px 0;
    padding: 3px 7px;
    border: 1px solid var(--accent-line);
    border-radius: 10px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 10.5px;
    line-height: 1.4;
  }
  .quote-chip span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .quote-chip button { color: inherit; font-size: 15px; line-height: 1; }
  .quote-message {
    display: block;
    max-width: 100%;
    padding: 3px 9px;
    border: none;
    border-left: 3px solid var(--line);
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-style: italic;
    text-align: left;
    white-space: pre-wrap;
    cursor: pointer;
  }
  .quote-body { white-space: pre-wrap; }
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
  .tier {
    flex: none;
    height: 20px;
    padding: 0 8px;
    border-radius: 10px;
    border: 1px solid var(--line);
    font-size: 10.5px;
    color: var(--muted);
    transition: border-color var(--t-hover), color var(--t-hover), background var(--t-hover);
  }
  .tier:hover {
    border-color: var(--accent-line);
    color: var(--accent);
  }
  .tier.cheap {
    background: var(--accent-soft);
    border-color: var(--accent-line);
    color: var(--accent);
  }
  /* 碰撞模式胶囊：开态用 --collide-pro 提亮，与 tier 同款胶囊形态 */
  .tier.collide.on {
    background: color-mix(in srgb, var(--collide-pro) 14%, transparent);
    border-color: color-mix(in srgb, var(--collide-pro) 55%, var(--line));
    color: var(--collide-pro);
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
