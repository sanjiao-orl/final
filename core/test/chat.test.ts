// 测试：/chat SSE 管道——mock 模型（ai/test 的 MockLanguageModelV3）驱动的事件序列、落库、工具多轮、断连中止。
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
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
  return fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('/chat SSE 管道', () => {
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

  it('客户端断连：中止 LLM 请求，不落库 assistant 消息（用户消息已落库）', async () => {
    let aborted = false;
    const s = await startTestServer({ modelForTier: () => hangingModel(() => (aborted = true)) });
    try {
      const controller = new AbortController();
      const res = await fetch(`${s.baseUrl}/chat`, {
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
});
