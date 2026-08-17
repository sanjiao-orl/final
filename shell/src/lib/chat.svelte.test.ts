// chat.svelte.ts 单测：双讨论存区切换、会话恢复、send 流式链路（含切存区不回写、纯工具轮清理）、
// B6 危险工具审批联动（ask 挂起 / yolo 直放）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatStreamHandlers, CoreClient } from './core.js';
import { ChatStore } from './chat.svelte.js';
import { approval } from './approval.svelte.js';
import { settings } from './settings.svelte.js';
import { snapshot } from './snapshot.svelte.js';
import { work } from './work.svelte.js';

beforeEach(() => {
  // work 是模块单例，重置被 chat 引用的字段，避免测试间泄漏
  work.workDir = '';
  work.error = null;
  work.notice = null;
  work.current = null;
  work.structure = [];
  work.dirty = false;
  work.reloadNonce = 0;
  // approval 是模块单例：清挂起卡，避免跨用例泄漏
  approval.pending = [];
  approval.active = null;
});

function streamClient(overrides: Record<string, unknown> = {}): CoreClient {
  return {
    listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    sessionMessages: vi.fn().mockResolvedValue({ sessionId: 's', messages: [] }),
    chatStream: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as CoreClient;
}

describe('ChatStore', () => {
  it('send：user + assistant 占位落 messages，delta 追加、工具行状态、done 回写 sessionId 并刷会话列表', async () => {
    const chatStream = vi.fn().mockImplementation(async (_body: unknown, h: ChatStreamHandlers) => {
      h.onDelta('你好');
      h.onToolCall?.({ id: 't1', name: 'word_count', args: { relPath: 'ch01.md' } });
      h.onToolResult?.({ id: 't1', name: 'word_count', result: { count: 42 } });
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const listSessions = vi.fn().mockResolvedValue({ sessions: [] });
    const client = streamClient({ chatStream, listSessions });
    const chat = new ChatStore();
    chat.init(client);
    work.workDir = 'C:/works/demo';

    await chat.send('帮我看看');
    expect(chat.messages[0]).toEqual({ role: 'user', content: '帮我看看' });
    expect(chat.messages[1]).toEqual({
      role: 'assistant',
      content: '你好',
      tools: [
        {
          id: 't1',
          name: 'word_count',
          args: { relPath: 'ch01.md' },
          result: { count: 42 },
          state: 'done',
        },
      ],
    });
    expect(chat.sessionId).toBe('s1');
    expect(chat.streaming).toBe(false);
    expect(chatStream).toHaveBeenCalledWith(
      { text: '帮我看看', workDir: 'C:/works/demo', scope: '', tier: 'writing' },
      expect.anything(),
      expect.anything(),
    );
    expect(listSessions).toHaveBeenCalled(); // onDone 后刷会话列表
  });

  it('send：已有 sessionId 时续聊请求带 sessionId', async () => {
    const chatStream = vi.fn().mockImplementation(async (_body: unknown, h: ChatStreamHandlers) => {
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const client = streamClient({ chatStream });
    const chat = new ChatStore();
    chat.init(client);
    chat.sessionId = 's1';
    await chat.send('继续');
    expect(chatStream).toHaveBeenCalledWith({ sessionId: 's1', text: '继续', workDir: '', tier: 'writing' }, expect.anything(), expect.anything());
  });

  it('send：tier=background 时请求带 background 档', async () => {
    const chatStream = vi.fn().mockImplementation(async (_body: unknown, h: ChatStreamHandlers) => {
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const client = streamClient({ chatStream });
    const chat = new ChatStore();
    chat.init(client);
    chat.setTier('background');
    expect(chat.tier).toBe('background');
    await chat.send('用便宜档跑');
    expect(chatStream).toHaveBeenCalledWith(
      { text: '用便宜档跑', workDir: '', scope: '', tier: 'background' },
      expect.anything(),
      expect.anything(),
    );
    chat.setTier('writing');
    expect(chat.tier).toBe('writing');
  });

  it('send：空文本或流式进行中不发请求', async () => {
    const chatStream = vi.fn();
    const client = streamClient({ chatStream });
    const chat = new ChatStore();
    chat.init(client);
    await chat.send('   ');
    expect(chatStream).not.toHaveBeenCalled();
    chat.streaming = true;
    await chat.send('发不出去');
    expect(chatStream).not.toHaveBeenCalled();
    expect(chat.messages).toEqual([]);
  });

  it('send：请求抛错 → error 消息；服务端 onError → 服务端错误消息', async () => {
    const throwClient = streamClient({
      chatStream: vi.fn().mockImplementation(() => {
        throw new Error('网络断开');
      }),
    });
    const chat = new ChatStore();
    chat.init(throwClient);
    await chat.send('x');
    expect(chat.messages.at(-1)).toEqual({ role: 'error', content: '请求失败：网络断开' });
    expect(chat.streaming).toBe(false);

    const errClient = streamClient({
      chatStream: vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
        h.onError?.(new Error('服务端炸了'));
      }),
    });
    const chat2 = new ChatStore();
    chat2.init(errClient);
    await chat2.send('x');
    expect(chat2.messages.at(-1)).toEqual({ role: 'error', content: '服务端错误：服务端炸了' });
  });

  it('send：纯工具轮（无文本无工具行）→ assistant 占位被移除', async () => {
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const client = streamClient({ chatStream });
    const chat = new ChatStore();
    chat.init(client);
    await chat.send('调用工具');
    expect(chat.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('send：流式期间切换存区 → done 不回写 sessionId（服务端会话已落库，现场不污染）', async () => {
    let h!: ChatStreamHandlers;
    let resolveStream!: () => void;
    const chatStream = vi.fn().mockImplementation((_b: unknown, handlers: ChatStreamHandlers) => {
      h = handlers;
      return new Promise<void>((r) => {
        resolveStream = r;
      });
    });
    const client = streamClient({ chatStream });
    const chat = new ChatStore();
    chat.init(client);
    chat.scope = '章节A.md';
    const p = chat.send('问题');
    chat.scope = '章节B.md'; // 流式期间切走
    h.onDone?.({ sessionId: 's2', messageId: 'm2' });
    resolveStream();
    await p;
    expect(chat.sessionId).toBeNull(); // 不回写新存区
  });

  it('setScope：清现场、按归属拉会话列表、自动打开最近会话', async () => {
    const session = { id: 's1', title: '最近的讨论', scope: '章节A.md', updatedAt: '2026-08-01T00:00:00Z' };
    const listSessions = vi.fn().mockResolvedValue({ sessions: [session] });
    const sessionMessages = vi.fn().mockResolvedValue({
      sessionId: 's1',
      messages: [{ id: 'm1', role: 'user', content: '旧消息' }],
    });
    const client = streamClient({ listSessions, sessionMessages });
    const chat = new ChatStore();
    chat.init(client);
    await chat.setScope('章节A.md');
    expect(listSessions).toHaveBeenCalledWith('章节A.md');
    expect(chat.sessionId).toBe('s1');
    expect(chat.messages[0]?.content).toBe('旧消息');
  });

  it('openSession：toolCalls 映射为 done 工具行；读取失败 → error 消息', async () => {
    const okClient = streamClient({
      sessionMessages: vi.fn().mockResolvedValue({
        sessionId: 's1',
        messages: [
          { id: 'm1', role: 'user', content: '查字数' },
          {
            id: 'm2',
            role: 'assistant',
            content: '共 42 字。',
            toolCalls: [{ id: 'tc-1', name: 'word_count', args: { relPath: 'ch01.md' } }],
          },
        ],
      }),
    });
    const chat = new ChatStore();
    chat.init(okClient);
    await chat.openSession('s1');
    expect(chat.messages[1]).toEqual({
      role: 'assistant',
      content: '共 42 字。',
      tools: [{ id: 'tc-1', name: 'word_count', args: { relPath: 'ch01.md' }, state: 'done' }],
    });

    const failClient = streamClient({ sessionMessages: vi.fn().mockRejectedValue(new Error('404')) });
    const chat2 = new ChatStore();
    chat2.init(failClient);
    await chat2.openSession('s1');
    expect(chat2.messages[0]).toEqual({ role: 'error', content: '会话读取失败：404' });
  });

  it('loadSessions 失败不挡主链路：sessions 置空', async () => {
    const client = streamClient({ listSessions: vi.fn().mockRejectedValue(new Error('core 挂了')) });
    const chat = new ChatStore();
    chat.init(client);
    await chat.loadSessions();
    expect(chat.sessions).toEqual([]);
  });

  it('newSession：清空现场', async () => {
    const chat = new ChatStore();
    chat.sessionId = 's1';
    chat.messages = [{ role: 'user', content: 'x' }];
    chat.newSession();
    expect(chat.sessionId).toBeNull();
    expect(chat.messages).toEqual([]);
  });

  it('newSession / openSession / setScope：调用即清空 approval 会话放行表（下次同类工具重新询问）', async () => {
    // 建立一次会话放行，再触发新会话/打开历史/切存区，验证同工具重新挂起。
    let n = 0;
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      n++;
      h.onToolCall?.({ id: `w${n}`, name: 'write_chapter', args: { relPath: 'manuscript/a.md' } });
      h.onToolResult?.({ id: `w${n}`, name: 'write_chapter', result: { ok: true } });
      h.onDone?.({ sessionId: `s${n}`, messageId: `m${n}` });
    });
    const listSessions = vi.fn().mockResolvedValue({ sessions: [] });
    const sessionMessages = vi.fn().mockResolvedValue({ sessionId: 's2', messages: [] });
    const client = streamClient({ chatStream, listSessions, sessionMessages });
    const chat = new ChatStore();
    chat.init(client);
    settings.approvalMode = 'auto';
    await chat.send('写');
    await chat.resolveApproval('session');
    // 同会话同工具同目标：放行
    expect(approval.pending).toEqual([]);
    expect(approval.active).toBeNull();

    // 新建会话：放行表清空，下次重新挂起
    chat.newSession();
    await chat.send('写');
    expect(approval.pending).toHaveLength(1);
    expect(approval.active?.callId).toBe('w2');
    await chat.resolveApproval('session');

    // 打开历史会话：放行表清空
    await chat.openSession('s2');
    await chat.send('写');
    expect(approval.pending).toHaveLength(1);
    expect(approval.active?.callId).toBe('w3');
    await chat.resolveApproval('session');

    // 切存区：放行表清空
    await chat.setScope('manuscript/a.md');
    await chat.send('写');
    expect(approval.pending).toHaveLength(1);
    expect(approval.active?.callId).toBe('w4');
  });
});

describe('ChatStore · B6 审批联动', () => {
  it('ask 模式：危险工具（write_chapter）挂起待审批，结果不落 done', async () => {
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onToolCall?.({ id: 'w1', name: 'write_chapter', args: { relPath: 'manuscript/a.md', content: 'x' } });
      h.onToolResult?.({ id: 'w1', name: 'write_chapter', result: { ok: true, bytes: 1 } });
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const client = streamClient({ chatStream });
    const chat = new ChatStore();
    chat.init(client);
    settings.approvalMode = 'ask';
    await chat.send('帮我写一章');
    const tool = chat.messages[1]?.tools?.[0];
    expect(tool?.state).toBe('pending');
    expect(approval.active?.name).toBe('write_chapter');
    expect(approval.active?.target).toBe('manuscript/a.md');
    expect(tool?.result).toEqual({ ok: true, bytes: 1 });
  });

  it('yolo 模式：危险工具直放，工具卡落 done，不挂卡', async () => {
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onToolCall?.({ id: 'w1', name: 'write_chapter', args: { relPath: 'manuscript/a.md' } });
      h.onToolResult?.({ id: 'w1', name: 'write_chapter', result: { ok: true } });
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const client = streamClient({ chatStream });
    const chat = new ChatStore();
    chat.init(client);
    settings.approvalMode = 'yolo';
    await chat.send('帮我写一章');
    expect(chat.messages[1]?.tools?.[0]?.state).toBe('done');
    expect(approval.pending).toEqual([]);
  });

  it('auto 模式：允许本会话后同类同目标不再询问', async () => {
    let n = 0;
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      n++;
      h.onToolCall?.({ id: `w${n}`, name: 'write_chapter', args: { relPath: 'manuscript/a.md' } });
      h.onToolResult?.({ id: `w${n}`, name: 'write_chapter', result: { ok: true } });
      h.onDone?.({ sessionId: 's1', messageId: `m${n}` });
    });
    const client = streamClient({ chatStream });
    const chat = new ChatStore();
    chat.init(client);
    settings.approvalMode = 'auto';
    await chat.send('写一次');
    expect(approval.active?.callId).toBe('w1');
    await chat.resolveApproval('session');
    // 缺陷 2：放行本会话后，第一次的工具卡必须从 pending 推进到 done（否则卡片永久假死）。
    expect(chat.messages[1]?.tools?.[0]?.state).toBe('done');
    expect(approval.pending).toEqual([]);
    await chat.send('再写一次');
    expect(chat.messages[3]?.tools?.[0]?.state).toBe('done');
    expect(approval.pending).toEqual([]);
  });

  it('auto 模式：允许一次后本次工具卡落 done，第二次同类同目标仍询问', async () => {
    let n = 0;
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      n++;
      h.onToolCall?.({ id: `w${n}`, name: 'write_chapter', args: { relPath: 'manuscript/once.md' } });
      h.onToolResult?.({ id: `w${n}`, name: 'write_chapter', result: { ok: true } });
      h.onDone?.({ sessionId: 's1', messageId: `m${n}` });
    });
    const client = streamClient({ chatStream });
    const chat = new ChatStore();
    chat.init(client);
    settings.approvalMode = 'auto';
    await chat.send('写一次');
    expect(chat.messages[1]?.tools?.[0]?.state).toBe('pending');
    await chat.resolveApproval('once');
    expect(chat.messages[1]?.tools?.[0]?.state).toBe('done');
    expect(approval.pending).toEqual([]);
    await chat.send('再写一次');
    expect(chat.messages[3]?.tools?.[0]?.state).toBe('pending');
    expect(approval.active?.callId).toBe('w2');
  });

  it('拒绝 write_chapter：工具卡落 rejected，走快照还原补偿', async () => {
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onToolCall?.({ id: 'w1', name: 'write_chapter', args: { relPath: 'manuscript/a.md', content: 'x' } });
      h.onToolResult?.({ id: 'w1', name: 'write_chapter', result: { ok: true, bytes: 1 } });
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ snapshots: [{ path: '.novel/history/a/20260812-1.md', timestamp: '20260812-1' }] }) // list_snapshots
      .mockResolvedValueOnce({ ok: true, content: '旧内容' }) // read_snapshot
      .mockResolvedValueOnce(undefined); // write_chapter 还原
    const client = streamClient({ chatStream, callTool });
    const chat = new ChatStore();
    chat.init(client);
    snapshot.init(client, 'C:/works/demo');
    work.workDir = 'C:/works/demo';
    settings.approvalMode = 'ask';
    await chat.send('帮我写一章');
    expect(approval.active).not.toBeNull();
    await chat.resolveApproval('reject');
    expect(chat.messages[1]?.tools?.[0]?.state).toBe('rejected');
    expect(approval.pending).toEqual([]);
    expect(callTool).toHaveBeenCalledWith('read_snapshot', {
      workDir: 'C:/works/demo',
      snapshotPath: '.novel/history/a/20260812-1.md',
    });
    expect(callTool).toHaveBeenCalledWith('write_chapter', {
      workDir: 'C:/works/demo',
      relPath: 'manuscript/a.md',
      content: '旧内容',
    });
  });

  it('放行 write_chapter 且目标是当前打开章：重载当前章刷新 savedMd 与编辑器现场', async () => {
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onToolCall?.({ id: 'w1', name: 'write_chapter', args: { relPath: 'manuscript/a.md', content: 'AI 新文' } });
      h.onToolResult?.({ id: 'w1', name: 'write_chapter', result: { ok: true } });
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const callTool = vi
      .fn()
      .mockResolvedValue({ content: 'AI 新文', frontmatter: {}, frontmatterRaw: '---\n---\n', body: 'AI 新文' });
    const client = streamClient({ chatStream, callTool });
    const chat = new ChatStore();
    chat.init(client);
    work.init(client, 'C:/works/demo');
    work.current = {
      relPath: 'manuscript/a.md',
      title: '第一章',
      frontmatterRaw: '---\n---\n',
      frontmatter: {},
      savedMd: '旧文',
    };
    settings.approvalMode = 'ask';
    await chat.send('帮我写');
    expect(chat.messages[1]?.tools?.[0]?.state).toBe('pending');
    await chat.resolveApproval('once');
    expect(callTool).toHaveBeenCalledWith('read_chapter', {
      workDir: 'C:/works/demo',
      relPath: 'manuscript/a.md',
    });
    expect(work.current?.savedMd).toBe('AI 新文');
    expect(work.reloadNonce).toBe(1);
    expect(chat.messages[1]?.tools?.[0]?.state).toBe('done');
  });

  it('多挂起卡：按 callId 拒绝本卡，不影响其他挂起卡', async () => {
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onToolCall?.({ id: 'w1', name: 'write_chapter', args: { relPath: 'manuscript/a.md' } });
      h.onToolResult?.({ id: 'w1', name: 'write_chapter', result: { ok: true } });
      h.onToolCall?.({ id: 'e1', name: 'export_txt', args: {} });
      h.onToolResult?.({ id: 'e1', name: 'export_txt', result: { path: 'C:/works/demo/全稿.txt' } });
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const client = streamClient({ chatStream });
    const chat = new ChatStore();
    chat.init(client);
    settings.approvalMode = 'ask';
    await chat.send('写一章并导出');
    expect(chat.messages[1]?.tools?.map((t) => t.state)).toEqual(['pending', 'pending']);
    expect(approval.active?.callId).toBe('w1');
    await chat.resolveApproval('reject', 'e1');
    expect(chat.messages[1]?.tools?.find((t) => t.id === 'e1')?.state).toBe('rejected');
    expect(chat.messages[1]?.tools?.find((t) => t.id === 'w1')?.state).toBe('pending');
    expect(approval.pending.map((p) => p.callId)).toEqual(['w1']);
    expect(approval.active?.callId).toBe('w1');
  });

  it('abortStream：流式期间取消 → signal 被 abort、assistant 占位保留、流式复位', async () => {
    let h!: ChatStreamHandlers;
    let resolveStream!: () => void;
    const chatStream = vi.fn().mockImplementation((_b: unknown, handlers: ChatStreamHandlers) => {
      h = handlers;
      return new Promise<void>((r) => {
        resolveStream = r;
      });
    });
    const client = streamClient({ chatStream });
    const chat = new ChatStore();
    chat.init(client);
    const p = chat.send('慢慢写');
    h.onDelta('写到一半');
    chat.abortStream();
    resolveStream();
    await p;
    expect(chat.streaming).toBe(false);
    expect(chat.abortedLastStream).toBe(true);
    expect(chat.messages.find((m) => m.role === 'error')).toBeUndefined();
    // 占位保留 + 内容保留（已生成部分不丢）
    const assistant = chat.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toContain('写到一半');
  });

  it('abortStream：流式未开始时调用为 no-op', async () => {
    const chat = new ChatStore();
    expect(() => chat.abortStream()).not.toThrow();
  });
});

describe('ChatStore · 批三-3 章节挂载（chapter 字段）与账本联动', () => {
  const CH_NODE = {
    type: 'chapter' as const,
    title: '第一章',
    relPath: 'manuscript/a.md',
    wordCount: 0,
    scenes: [] as import('./types.js').SceneNode[],
    id: 'ch-abc',
  };

  function doneStream() {
    return vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
  }

  it('send：scope=ch:<id> 且结构树解析到章 → 请求体带 chapter=relPath（新会话）', async () => {
    const chatStream = doneStream();
    const client = streamClient({ chatStream });
    const chat = new ChatStore();
    chat.init(client);
    work.structure = [{ type: 'volume', title: '第一卷', children: [CH_NODE] }];
    chat.scope = 'ch:ch-abc';
    await chat.send('帮我看这章');
    expect(chatStream).toHaveBeenCalledWith(
      { text: '帮我看这章', workDir: '', scope: 'ch:ch-abc', tier: 'writing', chapter: 'manuscript/a.md' },
      expect.anything(),
      expect.anything(),
    );
  });

  it('send：scope=ch:<id> 且已有会话 → 请求体同样带 chapter', async () => {
    const chatStream = doneStream();
    const client = streamClient({ chatStream });
    const chat = new ChatStore();
    chat.init(client);
    chat.sessionId = 's1';
    work.structure = [{ type: 'volume', title: '第一卷', children: [CH_NODE] }];
    chat.scope = 'ch:ch-abc';
    await chat.send('继续');
    expect(chatStream).toHaveBeenCalledWith(
      { sessionId: 's1', text: '继续', workDir: '', tier: 'writing', chapter: 'manuscript/a.md' },
      expect.anything(),
      expect.anything(),
    );
  });

  it('send：scope=ch:<unknown> 结构树解析不到 → 不带 chapter', async () => {
    const chatStream = doneStream();
    const client = streamClient({ chatStream });
    const chat = new ChatStore();
    chat.init(client);
    work.structure = [];
    chat.scope = 'ch:ghost';
    await chat.send('这章挂了');
    expect(chatStream).toHaveBeenCalledWith(
      { text: '这章挂了', workDir: '', scope: 'ch:ghost', tier: 'writing' },
      expect.anything(),
      expect.anything(),
    );
  });

  it('send：非章挂载（vol:）→ 不带 chapter', async () => {
    const chatStream = doneStream();
    const client = streamClient({ chatStream });
    const chat = new ChatStore();
    chat.init(client);
    chat.scope = 'vol:第一卷';
    await chat.send('卷内讨论');
    expect(chatStream).toHaveBeenCalledWith(
      { text: '卷内讨论', workDir: '', scope: 'vol:第一卷', tier: 'writing' },
      expect.anything(),
      expect.anything(),
    );
  });

  it('refreshAfterTools：ledger_upsert 落定 → 按当前口径重拉上下文栏', async () => {
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onToolCall?.({ id: 'l1', name: 'ledger_upsert', args: { kind: 'prop', name: '剑' } });
      h.onToolResult?.({ id: 'l1', name: 'ledger_upsert', result: { ok: true } });
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const callTool = vi.fn().mockResolvedValue({
      workDir: 'C:/works/demo',
      chapterRelPath: 'manuscript/a.md',
      found: true,
      chapterTitle: '第一章',
      ledger: { clock: [], props: [], promises: [], knowledge: [], doNotReexplain: [], protect: [], tripwires: [] },
      slice: '# 切片',
    });
    const client = streamClient({ chatStream, callTool });
    const chat = new ChatStore();
    chat.init(client);
    snapshot.init(client, 'C:/works/demo');
    work.workDir = 'C:/works/demo';
    work.current = { relPath: 'manuscript/a.md', title: '第一章', frontmatter: {}, frontmatterRaw: '', savedMd: 'x' };
    await chat.send('记道具');
    expect(callTool).toHaveBeenCalledWith('ledger_chapter_slice', {
      workDir: 'C:/works/demo',
      chapterRelPath: 'manuscript/a.md',
    });
  });
});

describe('ChatStore · D3 分组与定位', () => {
  it('focusToolsGroupKey 初始为 null，可设可清', () => {
    const chat = new ChatStore();
    expect(chat.focusToolsGroupKey).toBeNull();
    chat.focusToolsGroupKey = '3';
    expect(chat.focusToolsGroupKey).toBe('3');
    chat.focusToolsGroupKey = null;
    expect(chat.focusToolsGroupKey).toBeNull();
  });

  it('toolGroups：按 assistant 消息聚合，组头=前一条 user 消息前 20 字', async () => {
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onToolCall?.({ id: 'a1', name: 'word_count', args: { relPath: 'a.md' } });
      h.onToolResult?.({ id: 'a1', name: 'word_count', result: { total: 10 } });
      h.onToolCall?.({ id: 'a2', name: 'search_content', args: { query: '林渡' } });
      h.onToolResult?.({ id: 'a2', name: 'search_content', result: [] });
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const chat = new ChatStore();
    chat.init(streamClient({ chatStream }));
    await chat.send('帮我查一下字数并搜主角名');
    expect(chat.toolGroups).toHaveLength(1);
    const g = chat.toolGroups[0]!;
    expect(g.key).toBe('1'); // assistant 在 messages 下标 1
    expect(g.userPrompt).toBe('帮我查一下字数并搜主角名'); // 不足 20 字，原样
    expect(g.tools.map((t) => t.name)).toEqual(['word_count', 'search_content']);
    expect(g.hasPending).toBe(false);
  });

  it('toolGroups：多条含工具的 assistant 消息 → 多组；userPrompt 跟随各自前一条', async () => {
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onToolCall?.({ id: 'a1', name: 'word_count', args: {} });
      h.onToolResult?.({ id: 'a1', name: 'word_count', result: { total: 10 } });
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const chat = new ChatStore();
    chat.init(streamClient({ chatStream }));
    await chat.send('第一轮：查字数');
    // 模拟第二轮：push 新 user + assistant + tool（直接操作 store，绕过 send）
    chat.messages.push({ role: 'user', content: '第二轮：再来一次' });
    chat.messages.push({
      role: 'assistant',
      content: '',
      tools: [{ id: 'b1', name: 'list_structure', args: {}, state: 'running' }],
    });
    expect(chat.toolGroups).toHaveLength(2);
    expect(chat.toolGroups[0]!.key).toBe('1');
    expect(chat.toolGroups[0]!.userPrompt).toBe('第一轮：查字数');
    expect(chat.toolGroups[1]!.key).toBe('3');
    expect(chat.toolGroups[1]!.userPrompt).toBe('第二轮：再来一次');
    expect(chat.toolGroups[1]!.hasPending).toBe(true); // running 计入
  });

  it('toolGroups：userPrompt 截断到 20 字', async () => {
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onToolCall?.({ id: 'a1', name: 'word_count', args: {} });
      h.onToolResult?.({ id: 'a1', name: 'word_count', result: {} });
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const chat = new ChatStore();
    chat.init(streamClient({ chatStream }));
    await chat.send('一二三四五六七八九十一二三四五六七八九十'); // 22 字
    expect(chat.toolGroups[0]!.userPrompt).toBe('一二三四五六七八九十一二三四五六七八九十'); // 前 20
    expect(chat.toolGroups[0]!.userPrompt.length).toBe(20);
  });

  it('toolStarted：send 中产生的 ToolLine 可查到起始时间；未记录的 tool 返回 undefined', async () => {
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onToolCall?.({ id: 'a1', name: 'word_count', args: {} });
      h.onToolResult?.({ id: 'a1', name: 'word_count', result: {} });
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const chat = new ChatStore();
    chat.init(streamClient({ chatStream }));
    const before = Date.now();
    await chat.send('测耗时');
    const after = Date.now();
    const tool = chat.messages[1]!.tools![0]!;
    const t = chat.toolStarted(tool);
    expect(t).toBeDefined();
    expect(t!).toBeGreaterThanOrEqual(before);
    expect(t!).toBeLessThanOrEqual(after);
    // 未通过 send 产生的 tool（外部 push）查不到
    const fake: import('./chat.svelte.js').ToolLine = {
      id: 'fake',
      name: 'noop',
      state: 'done',
    };
    expect(chat.toolStarted(fake)).toBeUndefined();
  });
});

describe('ChatStore · 对话草稿持久（反馈#1）', () => {
  it('currentDraftKey：有会话挂 session:<id>，无会话挂 scope:<scope>', () => {
    const chat = new ChatStore();
    chat.scope = 'work';
    chat.sessionId = null;
    expect(chat.currentDraftKey()).toBe('scope:work');
    chat.sessionId = 's1';
    expect(chat.currentDraftKey()).toBe('session:s1');
    chat.scope = 'ch:abc';
    expect(chat.currentDraftKey()).toBe('session:s1'); // 会话键优先，scope 变化不影响
    chat.sessionId = null;
    expect(chat.currentDraftKey()).toBe('scope:ch:abc');
  });

  it('getDraft/setDraft：设草稿 → 切键 → 切回草稿还在（关栏不丢）', () => {
    const chat = new ChatStore();
    chat.scope = 'work';
    const keyA = chat.currentDraftKey(); // scope:work
    chat.setDraft(keyA, '未发送的文字');
    chat.sessionId = 's1'; // 切到会话键（当前 session 场景）
    expect(chat.getDraft(chat.currentDraftKey())).toBe(''); // 新键无草稿
    chat.sessionId = null; // 切回 scope:work
    expect(chat.currentDraftKey()).toBe(keyA);
    expect(chat.getDraft(keyA)).toBe('未发送的文字');
  });

  it('发送成功后清该键草稿', async () => {
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const chat = new ChatStore();
    chat.init(streamClient({ chatStream }));
    chat.sessionId = 's1';
    const key = chat.currentDraftKey(); // session:s1
    chat.setDraft(key, '要发送的文字');
    await chat.send('要发送的文字');
    expect(chat.getDraft(key)).toBe('');
  });

  it('发送失败保留草稿；流式期间用户改写后成功不清新内容', async () => {
    // 失败不清：草稿留给用户重发
    const failClient = streamClient({
      chatStream: vi.fn().mockImplementation(() => {
        throw new Error('网络断开');
      }),
    });
    const chat = new ChatStore();
    chat.init(failClient);
    chat.scope = 'work';
    const key = chat.currentDraftKey();
    chat.setDraft(key, '正文');
    await chat.send('正文');
    expect(chat.getDraft(key)).toBe('正文');

    // 已有会话 + 流式期间用户改写：成功后保留新草稿（不误清）
    let h!: ChatStreamHandlers;
    let resolveStream!: () => void;
    const chatStream = vi.fn().mockImplementation((_b: unknown, handlers: ChatStreamHandlers) => {
      h = handlers;
      return new Promise<void>((r) => {
        resolveStream = r;
      });
    });
    const chat2 = new ChatStore();
    chat2.init(streamClient({ chatStream }));
    chat2.sessionId = 's1';
    const key2 = chat2.currentDraftKey(); // session:s1
    chat2.setDraft(key2, '旧草稿');
    const p = chat2.send('旧草稿');
    chat2.setDraft(key2, '流式期间写的新内容');
    h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    resolveStream();
    await p;
    expect(chat2.getDraft(key2)).toBe('流式期间写的新内容');
  });

  it('新会话建立：流式期间在输入框新写的草稿迁移到新会话键，不丢', async () => {
    let h!: ChatStreamHandlers;
    let resolveStream!: () => void;
    const chatStream = vi.fn().mockImplementation((_b: unknown, handlers: ChatStreamHandlers) => {
      h = handlers;
      return new Promise<void>((r) => {
        resolveStream = r;
      });
    });
    const chat = new ChatStore();
    chat.init(streamClient({ chatStream }));
    chat.scope = 'work';
    chat.sessionId = null;
    const scopeKey = chat.currentDraftKey(); // scope:work
    chat.setDraft(scopeKey, ''); // 发送瞬间 ChatColumn 已清空输入框
    const p = chat.send('第一条');
    chat.setDraft(scopeKey, '第二条：流式中新写'); // 流式期间用户接着打字
    h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    resolveStream();
    await p;
    expect(chat.sessionId).toBe('s1');
    expect(chat.getDraft('session:s1')).toBe('第二条：流式中新写'); // 已迁移到新会话键
    expect(chat.getDraft(scopeKey)).toBe(''); // 原键清空
  });
});

describe('ChatStore · AI 写完自动刷新（反馈#6）', () => {
  it('write_chapter 命中当前章：loadStructure 刷字数 + reloadCurrent 以磁盘为准', async () => {
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onToolCall?.({ id: 'w1', name: 'write_chapter', args: { relPath: 'manuscript/a.md', content: 'AI 新文' } });
      h.onToolResult?.({ id: 'w1', name: 'write_chapter', result: { ok: true } });
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const callTool = vi.fn((name: string) => {
      if (name === 'list_structure') return Promise.resolve([]);
      if (name === 'read_chapter') {
        return Promise.resolve({ content: 'AI 新文', frontmatter: {}, frontmatterRaw: '---\n---\n', body: 'AI 新文' });
      }
      return Promise.resolve(undefined);
    });
    const client = streamClient({ chatStream, callTool });
    const chat = new ChatStore();
    chat.init(client);
    work.init(client, 'C:/works/demo');
    work.current = {
      relPath: 'manuscript/a.md',
      title: '第一章',
      frontmatterRaw: '---\n---\n',
      frontmatter: {},
      savedMd: '旧文',
    };
    settings.approvalMode = 'yolo'; // 直放 → 工具行落 done，刷新路径触发
    await chat.send('帮我写');
    expect(callTool).toHaveBeenCalledWith('list_structure', { workDir: 'C:/works/demo' });
    expect(callTool).toHaveBeenCalledWith('read_chapter', { workDir: 'C:/works/demo', relPath: 'manuscript/a.md' });
    expect(work.current?.savedMd).toBe('AI 新文');
    expect(work.reloadNonce).toBe(1);
  });

  it('结构变更工具（create_chapter）→ loadStructure 刷结构树', async () => {
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onToolCall?.({ id: 'c1', name: 'create_chapter', args: { volume: '第一卷·风起', title: '新章' } });
      h.onToolResult?.({ id: 'c1', name: 'create_chapter', result: { ok: true, relPath: 'manuscript/第一卷·风起/第4章·新章.md' } });
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const callTool = vi.fn().mockResolvedValue([]);
    const client = streamClient({ chatStream, callTool });
    const chat = new ChatStore();
    chat.init(client);
    work.init(client, 'C:/works/demo');
    await chat.send('新建一章');
    expect(callTool).toHaveBeenCalledWith('list_structure', { workDir: 'C:/works/demo' });
  });

  it('非结构工具（word_count）不刷结构树', async () => {
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onToolCall?.({ id: 'w1', name: 'word_count', args: { relPath: 'manuscript/a.md' } });
      h.onToolResult?.({ id: 'w1', name: 'word_count', result: { count: 42 } });
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const callTool = vi.fn().mockResolvedValue([]);
    const client = streamClient({ chatStream, callTool });
    const chat = new ChatStore();
    chat.init(client);
    work.workDir = 'C:/works/demo';
    await chat.send('查字数');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('自动刷新失败静默（console.warn），对话不受影响', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chatStream = vi.fn().mockImplementation(async (_b: unknown, h: ChatStreamHandlers) => {
      h.onToolCall?.({ id: 'w1', name: 'write_chapter', args: { relPath: 'manuscript/a.md' } });
      h.onToolResult?.({ id: 'w1', name: 'write_chapter', result: { ok: true } });
      h.onDone?.({ sessionId: 's1', messageId: 'm1' });
    });
    const callTool = vi.fn().mockRejectedValue(new Error('core 掉线'));
    const client = streamClient({ chatStream, callTool });
    const chat = new ChatStore();
    chat.init(client);
    work.init(client, 'C:/works/demo');
    settings.approvalMode = 'yolo';
    await chat.send('帮我写');
    expect(chat.messages.at(-1)?.role).not.toBe('error'); // 刷新失败不炸对话
    expect(chat.streaming).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
