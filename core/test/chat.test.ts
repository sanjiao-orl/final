// 测试：/v1/chat SSE 管道——mock 模型（ai/test 的 MockLanguageModelV3）驱动的事件序列、落库、工具多轮、断连中止。
import { tool, type ToolSet } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { readSse, startTestServer, stepModel, textResult, toolCallResult, hangingModel } from './helpers.js';

/** 与 domain 约定对齐的示例领域工具（透传语义，参数细节 core 不关心）。 */
const domainTools: ToolSet = {
  word_count: tool({
    description: '统计指定章节的字数',
    inputSchema: z.object({ relPath: z.string() }),
    execute: async ({ relPath }) => ({ relPath, count: 42 }),
  }),
};

function postChat(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** mock 模型收到的 prompt 消息 content 可能是 string 或 AI SDK 规范化的 content-part 数组，统一取文本。 */
function promptText(m: { content: unknown }): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content as { text?: string }[]).map((p) => p.text ?? '').join('');
}

describe('/v1/chat SSE 管道', () => {
  it('文本流：text-delta → done，用户与 assistant 消息落库，title 取首条用户消息前 20 字', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['你好，', '世界！'])]) });
    try {
      const longText = '这是第一条用户消息用来验证标题截取二十字';
      const res = await postChat(s.baseUrl, s.token, { text: longText });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const events = await readSse(res);
      expect(events.map((e) => e.event)).toEqual(['text-delta', 'text-delta', 'done']);
      expect(events[0]?.data.delta).toBe('你好，');
      expect(events[1]?.data.delta).toBe('世界！');
      expect(events[2]?.data.sessionId).toBeTruthy();
      expect(events[2]?.data.messageId).toBeTruthy();

      // 落库校验
      const sessionId = events[2]!.data.sessionId as string;
      const session = s.store.getSession(sessionId);
      expect(session?.title).toBe(longText.slice(0, 20));
      const messages = s.store.listMessages(sessionId);
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(messages[0]?.content).toBe(longText);
      expect(messages[1]?.content).toBe('你好，世界！');
      expect(messages[1]?.toolCalls).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it('工具多轮：tool-call → tool-result → text-delta → done，toolCalls 随 assistant 消息落库', async () => {
    const model = stepModel([
      toolCallResult('tc-1', 'word_count', { relPath: 'ch01.md' }),
      textResult(['共 42 字。']),
    ]);
    const s = await startTestServer({ modelForTier: () => model, tools: domainTools });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '统计第一章字数', tier: 'writing' });
      const events = await readSse(res);

      const names = events.map((e) => e.event);
      expect(names).toContain('tool-call');
      expect(names).toContain('tool-result');
      expect(names[names.length - 1]).toBe('done');

      const toolCall = events.find((e) => e.event === 'tool-call')!.data;
      expect(toolCall.name).toBe('word_count');
      expect(toolCall.args).toEqual({ relPath: 'ch01.md' });
      const toolResult = events.find((e) => e.event === 'tool-result')!.data;
      expect(toolResult.result).toEqual({ relPath: 'ch01.md', count: 42 });

      // 模型被调用两次（每步一次）
      expect(model.doStreamCalls).toHaveLength(2);

      // 落库：assistant 消息带 toolCalls
      const sessionId = events[events.length - 1]!.data.sessionId as string;
      const messages = s.store.listMessages(sessionId);
      const assistant = messages[messages.length - 1]!;
      expect(assistant.role).toBe('assistant');
      expect(assistant.toolCalls).toEqual([
        { id: 'tc-1', name: 'word_count', args: { relPath: 'ch01.md' } },
      ]);
    } finally {
      await s.close();
    }
  });

  it('指定已有 sessionId：追加到该会话，不新建', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['回复'])]) });
    try {
      const existing = s.store.createSession('旧会话');
      s.store.addMessage(existing.id, { role: 'user', content: '旧消息' });

      const res = await postChat(s.baseUrl, s.token, { sessionId: existing.id, text: '新消息' });
      const events = await readSse(res);
      expect(events[events.length - 1]!.data.sessionId).toBe(existing.id);

      const messages = s.store.listMessages(existing.id);
      expect(messages.map((m) => m.content)).toEqual(['旧消息', '新消息', '回复']);
      expect(s.store.listSessions()).toHaveLength(1); // 没有新建
    } finally {
      await s.close();
    }
  });

  it('sessionId 不存在 → 404（SSE 之前返回 JSON 错误）', async () => {
    const s = await startTestServer();
    try {
      const res = await postChat(s.baseUrl, s.token, { sessionId: '00000000-0000-4000-8000-000000000000', text: 'hi' });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
    } finally {
      await s.close();
    }
  });

  it('非法请求体 → 400', async () => {
    const s = await startTestServer();
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '' });
      expect(res.status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it('带 workDir：系统提示拼入作品路径，模型调工具可直接使用', async () => {
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '查字数', workDir: 'C:\\works\\demo' });
      expect(res.status).toBe(200);
      await readSse(res);
      const first = model.doStreamCalls[0] as { prompt: Array<{ role: string; content: unknown }> };
      const sys = first.prompt.find((m) => m.role === 'system');
      expect(JSON.stringify(sys?.content)).toContain('C:\\\\works\\\\demo');
    } finally {
      await s.close();
    }
  });

  it('服务端超时：provider 挂起时 SSE 收到 error 且连接正常结束', async () => {
    vi.stubEnv('LLM_TIMEOUT_SECONDS', '1');
    let aborted = false;
    const s = await startTestServer({ modelForTier: () => hangingModel(() => (aborted = true)) });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '超时测试' });
      expect(res.status).toBe(200);
      const events = await readSse(res);
      expect(events.map((e) => e.event)).toEqual(['text-delta', 'error']);
      expect(String(events.at(-1)?.data.message)).toContain('LLM 请求超时');
      expect(aborted).toBe(true); // 服务端超时信号送达 provider，LLM 请求被中止
    } finally {
      vi.unstubAllEnvs();
      await s.close();
    }
  });

  it('客户端断连：中止 LLM 请求，不落库 assistant 消息（用户消息已落库）', async () => {
    let aborted = false;
    const s = await startTestServer({ modelForTier: () => hangingModel(() => (aborted = true)) });
    try {
      const controller = new AbortController();
      const res = await fetch(`${s.baseUrl}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
        body: JSON.stringify({ text: '断连测试' }),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);

      // 读到第一个事件（text-delta 已到达）后主动断连
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let sawDelta = false;
      for (let guard = 0; guard < 50 && !sawDelta; guard++) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        sawDelta = buf.includes('text-delta');
      }
      expect(sawDelta).toBe(true);
      controller.abort();
      // 等待服务端感知断连并中止模型调用
      await new Promise((r) => setTimeout(r, 800));

      expect(aborted).toBe(true); // abortSignal 送达模型调用 = LLM 请求被中止
      const messages = s.store.listMessages(s.store.listSessions()[0]!.id);
      expect(messages.map((m) => m.role)).toEqual(['user']); // 只有用户消息
    } finally {
      await s.close();
    }
  });

  it('scope：新建会话记讨论归属，GET /v1/sessions?scope= 过滤；已有会话续聊不改归属', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['嗯。'])]) });
    try {
      // 章节内讨论：带 scope 建会话
      const res = await postChat(s.baseUrl, s.token, { text: '这段怎么改', scope: '第一卷/第一章.md' });
      const events = await readSse(res);
      const sessionId = events.at(-1)?.data.sessionId as string;
      expect(s.store.getSession(sessionId)?.scope).toBe('第一卷/第一章.md');

      // 无归属讨论：不带 scope 建会话
      const res2 = await postChat(s.baseUrl, s.token, { text: '全书基调怎么想' });
      const events2 = await readSse(res2);
      const sessionId2 = events2.at(-1)?.data.sessionId as string;
      expect(s.store.getSession(sessionId2)?.scope).toBe('');

      // 已有会话续聊时带不同 scope，不改归属
      const res3 = await postChat(s.baseUrl, s.token, { sessionId, text: '再想想', scope: '' });
      await readSse(res3);
      expect(s.store.getSession(sessionId)?.scope).toBe('第一卷/第一章.md');

      // ?scope= 过滤
      const scoped = await (
        await fetch(`${s.baseUrl}/v1/sessions?scope=${encodeURIComponent('第一卷/第一章.md')}`, {
          headers: { Authorization: `Bearer ${s.token}` },
        })
      ).json() as { sessions: { id: string }[] };
      expect(scoped.sessions.map((x) => x.id)).toEqual([sessionId]);
      const unscoped = await (
        await fetch(`${s.baseUrl}/v1/sessions?scope=`, { headers: { Authorization: `Bearer ${s.token}` } })
      ).json() as { sessions: { id: string }[] };
      expect(unscoped.sessions.map((x) => x.id)).toEqual([sessionId2]);
    } finally {
      await s.close();
    }
  });

  it('多轮会话回放：续聊时模型收到完整历史（首轮 user/assistant 都在，顺序正序）', async () => {
    const model = stepModel([textResult(['第一轮回复']), textResult(['第二轮回复'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res1 = await postChat(s.baseUrl, s.token, { text: '第一轮问题' });
      const ev1 = await readSse(res1);
      const sessionId = ev1.at(-1)!.data.sessionId as string;

      const res2 = await postChat(s.baseUrl, s.token, { sessionId, text: '第二轮问题' });
      const ev2 = await readSse(res2);
      expect(ev2.at(-1)!.event).toBe('done');

      const second = model.doStreamCalls[1]!.prompt.filter((m) => m.role !== 'system');
      expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(second.map((m) => promptText(m))).toEqual(['第一轮问题', '第一轮回复', '第二轮问题']);
    } finally {
      await s.close();
    }
  });

  it('回放纯工具轮：空文本 assistant 以工具摘要回放，不再跳过，相邻 user 仍合并', async () => {
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const sid = s.store.createSession('回放').id;
      s.store.addMessage(sid, { role: 'user', content: '第一问' });
      // 纯工具轮：无文本，只有 toolCalls——现在回放为一行工具摘要（工具结果仍不重放）
      s.store.addMessage(sid, {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'word_count', args: { relPath: 'ch01.md' } }],
      });
      s.store.addMessage(sid, { role: 'user', content: '追问' });

      const res = await postChat(s.baseUrl, s.token, { sessionId: sid, text: '最新问题' });
      const evs = await readSse(res);
      expect(evs.at(-1)!.event).toBe('done');

      const prompt = model.doStreamCalls[0]!.prompt.filter((m) => m.role !== 'system');
      expect(prompt.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(promptText(prompt[1]!)).toBe('[工具调用] word_count({"relPath":"ch01.md"})');
      expect(promptText(prompt[2]!)).toBe('追问\n最新问题'); // 相邻 user 合并成一条
    } finally {
      await s.close();
    }
  });

  it('回放条数预算：历史超过 20 条时只回放最近片段，当前消息必在末尾', async () => {
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const sid = s.store.createSession('预算').id;
      for (let i = 0; i < 30; i++) {
        s.store.addMessage(sid, { role: 'user', content: `第${i}条问题` });
        s.store.addMessage(sid, { role: 'assistant', content: `第${i}条回答` });
      }
      const res = await postChat(s.baseUrl, s.token, { sessionId: sid, text: '最新问题' });
      const evs = await readSse(res);
      expect(evs.at(-1)!.event).toBe('done');

      const prompt = model.doStreamCalls[0]!.prompt.filter((m) => m.role !== 'system');
      expect(prompt.length).toBe(19); // 61 条截到最近 20 条，首条 assistant 无 user 引导被裁 → 19
      expect(promptText(prompt.at(-1)!)).toBe('最新问题');
      expect(prompt.slice(0, 5).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
      expect(prompt.every((m, i) => (i % 2 === 0 ? m.role === 'user' : m.role === 'assistant'))).toBe(true); // 严格交替
    } finally {
      await s.close();
    }
  });

  it('回放字符预算：历史超 25k 字符只回放最近片段，截断后从 user 开始', async () => {
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const sid = s.store.createSession('预算').id;
      s.store.addMessage(sid, { role: 'user', content: 'A'.repeat(20_000) });
      s.store.addMessage(sid, { role: 'assistant', content: 'B'.repeat(20_000) });
      // 从最新往回：assistant 20k ≤ 25k 保留；user 20k 会超预算被截；回放 [assistant, user] 首条 assistant 被裁
      const res = await postChat(s.baseUrl, s.token, { sessionId: sid, text: '最新问题' });
      const evs = await readSse(res);
      expect(evs.at(-1)!.event).toBe('done');

      const prompt = model.doStreamCalls[0]!.prompt.filter((m) => m.role !== 'system');
      expect(prompt.map((m) => m.role)).toEqual(['user']);
      expect(promptText(prompt[0]!)).toBe('最新问题');
    } finally {
      await s.close();
    }
  });

  it('失败轮落库：后续步骤 provider 抛错时，已收集的 toolCalls 随部分 assistant 消息落库，SSE 收到 error', async () => {
    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        step++;
        if (step === 1) return toolCallResult('tc-1', 'word_count', { relPath: 'ch01.md' });
        // 第二步：provider 中途抛错
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.error(new Error('provider 中途抛错'));
            },
          }),
        };
      },
    });
    const s = await startTestServer({ modelForTier: () => model, tools: domainTools });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '统计第一章字数' });
      const events = await readSse(res);
      expect(events.map((e) => e.event)).toEqual(['tool-call', 'tool-result', 'error']);

      const sessionId = s.store.listSessions()[0]!.id;
      const messages = s.store.listMessages(sessionId);
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      const assistant = messages.at(-1)!;
      expect(assistant.content).toBe('');
      expect(assistant.toolCalls).toEqual([{ id: 'tc-1', name: 'word_count', args: { relPath: 'ch01.md' } }]);
    } finally {
      await s.close();
    }
  });

  it('失败轮落库：服务端超时已产生的文本随部分 assistant 消息落库，SSE 收到 error', async () => {
    vi.stubEnv('LLM_TIMEOUT_SECONDS', '1');
    const s = await startTestServer({ modelForTier: () => hangingModel(() => {}) });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '超时落库' });
      const events = await readSse(res);
      expect(events.map((e) => e.event)).toEqual(['text-delta', 'error']);

      const sessionId = s.store.listSessions()[0]!.id;
      const messages = s.store.listMessages(sessionId);
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(messages.at(-1)!.content).toBe('第一段');
      expect(messages.at(-1)!.toolCalls).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      await s.close();
    }
  });

  it('失败轮落库：多步工具轮在后续步骤超时时，已收集的 toolCalls 落库为部分 assistant 消息', async () => {
    vi.stubEnv('LLM_TIMEOUT_SECONDS', '1');
    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        step++;
        if (step === 1) return toolCallResult('tc-1', 'word_count', { relPath: 'ch01.md' });
        // 第二步挂起直到服务端超时中止
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              options.abortSignal?.addEventListener('abort', () => controller.error(new Error('provider stream aborted')));
            },
          }),
        };
      },
    });
    const s = await startTestServer({ modelForTier: () => model, tools: domainTools });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '统计第一章字数' });
      const events = await readSse(res);
      expect(events.map((e) => e.event)).toEqual(['tool-call', 'tool-result', 'error']);

      const sessionId = s.store.listSessions()[0]!.id;
      const messages = s.store.listMessages(sessionId);
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      const assistant = messages.at(-1)!;
      expect(assistant.content).toBe('');
      expect(assistant.toolCalls).toEqual([{ id: 'tc-1', name: 'word_count', args: { relPath: 'ch01.md' } }]);
    } finally {
      vi.unstubAllEnvs();
      await s.close();
    }
  });

  it('回放工具调用摘要：带 toolCalls 的 assistant 行 content 末尾追加 [工具调用]；空 content 有 toolCalls 不再跳过', async () => {
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const sid = s.store.createSession('回放').id;
      s.store.addMessage(sid, { role: 'user', content: '第一问' });
      // 纯工具轮：空 content + toolCalls，回放为一行摘要
      s.store.addMessage(sid, {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'word_count', args: { relPath: 'ch01.md' } }],
      });
      s.store.addMessage(sid, { role: 'user', content: '追问' });
      // 带文本 + toolCalls 的 assistant 行：content 末尾追加摘要
      s.store.addMessage(sid, {
        role: 'assistant',
        content: '我先查了字数。',
        toolCalls: [{ id: 'tc-2', name: 'word_count', args: { relPath: 'ch02.md' } }],
      });
      s.store.addMessage(sid, { role: 'user', content: '继续' });

      const res = await postChat(s.baseUrl, s.token, { sessionId: sid, text: '最新问题' });
      const evs = await readSse(res);
      expect(evs.at(-1)!.event).toBe('done');

      const prompt = model.doStreamCalls[0]!.prompt.filter((m) => m.role !== 'system');
      expect(prompt.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
      const assistantTexts = prompt.filter((m) => m.role === 'assistant').map((m) => promptText(m));
      // 纯工具轮行：回放内容就是摘要
      expect(assistantTexts[0]).toBe('[工具调用] word_count({"relPath":"ch01.md"})');
      // 带文本行：末尾追加摘要
      expect(assistantTexts[1]).toBe('我先查了字数。\n[工具调用] word_count({"relPath":"ch02.md"})');
      // 落库不受影响：摘要只进回放，不写库
      const stored = s.store.listMessages(sid).map((m) => m.content);
      expect(stored).not.toContain('[工具调用]');
      expect(stored.at(-1)).toBe('好'); // 本轮模型回复照常落库
    } finally {
      await s.close();
    }
  });
});