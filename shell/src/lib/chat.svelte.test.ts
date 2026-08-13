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
      { text: '帮我看看', workDir: 'C:/works/demo', scope: '' },
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
    expect(chatStream).toHaveBeenCalledWith({ sessionId: 's1', text: '继续', workDir: '' }, expect.anything());
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
});
