// 测试：/v1/chat SSE 管道——mock 模型（ai/test 的 MockLanguageModelV3）驱动的事件序列、落库、工具多轮、断连中止。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
        { id: 'tc-1', name: 'word_count', args: { relPath: 'ch01.md' }, result: '{"relPath":"ch01.md","count":42}' },
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

  it('带 workDir：系统提示拼入作品路径（归一化），模型调工具可直接使用', async () => {
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      // 真实存在的目录（workDir 现在要过存在性/目录校验）
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-chat-workdir-'));
      const res = await postChat(s.baseUrl, s.token, { text: '查字数', workDir });
      expect(res.status).toBe(200);
      await readSse(res);
      const first = model.doStreamCalls[0] as { prompt: Array<{ role: string; content: unknown }> };
      const sys = first.prompt.find((m) => m.role === 'system');
      // 归一化：相对路径会 resolve 成绝对路径后拼进系统提示
      expect(promptText(sys!)).toContain(path.resolve(workDir));
      fs.rmSync(workDir, { recursive: true, force: true });
    } finally {
      await s.close();
    }
  });

  it('workDir 含控制字符（换行）→ 400（注入面：目录名不得带换行等破出提示行）', async () => {
    const s = await startTestServer();
    try {
      const res = await postChat(s.baseUrl, s.token, { text: 'hi', workDir: 'C:/works/demo\n恶意注入' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('控制字符');
    } finally {
      await s.close();
    }
  });

  it('workDir 路径不存在 → 400（不拼进系统提示）', async () => {
    const s = await startTestServer();
    try {
      const res = await postChat(s.baseUrl, s.token, { text: 'hi', workDir: path.join(os.tmpdir(), 'core-no-such-dir-xyz') });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('workDir');
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
      expect(assistant.toolCalls).toEqual([
        { id: 'tc-1', name: 'word_count', args: { relPath: 'ch01.md' }, result: '{"relPath":"ch01.md","count":42}' },
      ]);
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
      expect(assistant.toolCalls).toEqual([
        { id: 'tc-1', name: 'word_count', args: { relPath: 'ch01.md' }, result: '{"relPath":"ch01.md","count":42}' },
      ]);
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

  it('工具结果落库截断：单条结果最多存 500 字符', async () => {
    const model = stepModel([
      toolCallResult('tc-1', 'long_result', {}),
      textResult(['完成']),
    ]);
    const longResultTools: ToolSet = {
      long_result: tool({
        description: '返回超长结果',
        inputSchema: z.object({}),
        execute: async () => 'L'.repeat(800),
      }),
    };
    const s = await startTestServer({ modelForTier: () => model, tools: longResultTools });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '执行长结果工具' });
      const events = await readSse(res);
      expect(events.at(-1)!.event).toBe('done');

      const sessionId = events.at(-1)!.data.sessionId as string;
      const assistant = s.store.listMessages(sessionId).at(-1)!;
      expect(assistant.toolCalls).toEqual([
        { id: 'tc-1', name: 'long_result', args: {}, result: 'L'.repeat(500) },
      ]);
    } finally {
      await s.close();
    }
  });

  it('回放工具结果成对：带 result 的轮输出 assistant(tool-call parts)+tool(tool-result parts)', async () => {
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const sid = s.store.createSession('成对回放').id;
      s.store.addMessage(sid, { role: 'user', content: '第一问' });
      s.store.addMessage(sid, {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'word_count', args: { relPath: 'ch01.md' }, result: '{"relPath":"ch01.md","count":42}' }],
      });
      s.store.addMessage(sid, { role: 'user', content: '追问' });

      const res = await postChat(s.baseUrl, s.token, { sessionId: sid, text: '最新问题' });
      const evs = await readSse(res);
      expect(evs.at(-1)!.event).toBe('done');

      const prompt = model.doStreamCalls[0]!.prompt.filter((m) => m.role !== 'system');
      expect(prompt.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
      expect(prompt[1]!.content).toEqual([
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'word_count', input: { relPath: 'ch01.md' } },
      ]);
      expect(prompt[2]!.content).toEqual([
        {
          type: 'tool-result',
          toolCallId: 'tc-1',
          toolName: 'word_count',
          output: { type: 'text', value: '{"relPath":"ch01.md","count":42}' },
        },
      ]);
      expect(promptText(prompt[3]!)).toBe('追问\n最新问题');
    } finally {
      await s.close();
    }
  });

  it('回放旧数据/部分缺 result：整轮回退摘要行，不混合拼半对', async () => {
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const sid = s.store.createSession('旧数据回退').id;
      s.store.addMessage(sid, { role: 'user', content: '第一问' });
      s.store.addMessage(sid, {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc-1', name: 'word_count', args: { relPath: 'ch01.md' }, result: '有结果' },
          { id: 'tc-2', name: 'word_count', args: { relPath: 'ch02.md' } },
        ],
      });
      s.store.addMessage(sid, { role: 'user', content: '追问' });

      const res = await postChat(s.baseUrl, s.token, { sessionId: sid, text: '最新问题' });
      const evs = await readSse(res);
      expect(evs.at(-1)!.event).toBe('done');

      const prompt = model.doStreamCalls[0]!.prompt.filter((m) => m.role !== 'system');
      expect(prompt.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(promptText(prompt[1]!)).toBe('[工具调用] word_count({"relPath":"ch01.md"})、word_count({"relPath":"ch02.md"})');
      expect(promptText(prompt[2]!)).toBe('追问\n最新问题');
    } finally {
      await s.close();
    }
  });

  it('回放工具结果截断：单条结果最多回放 500 字符(与落库同值)', async () => {
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const sid = s.store.createSession('结果截断').id;
      s.store.addMessage(sid, { role: 'user', content: '第一问' });
      s.store.addMessage(sid, {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'read_file', args: {}, result: 'R'.repeat(10_000) }],
      });
      s.store.addMessage(sid, { role: 'user', content: '追问' });

      const res = await postChat(s.baseUrl, s.token, { sessionId: sid, text: '最新问题' });
      const evs = await readSse(res);
      expect(evs.at(-1)!.event).toBe('done');

      const prompt = model.doStreamCalls[0]!.prompt.filter((m) => m.role !== 'system');
      expect(prompt.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
      const toolMsg = prompt.find((m) => m.role === 'tool')!;
      expect(toolMsg.content).toEqual([
        {
          type: 'tool-result',
          toolCallId: 'tc-1',
          toolName: 'read_file',
          output: { type: 'text', value: 'R'.repeat(500) },
        },
      ]);
    } finally {
      await s.close();
    }
  });

  it('回放结果计入字符预算：正文+结果超 25k 时整组裁掉，不留孤儿工具消息', async () => {
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const sid = s.store.createSession('结果预算').id;
      s.store.addMessage(sid, { role: 'user', content: '第一问' });
      s.store.addMessage(sid, {
        role: 'assistant',
        content: 'B'.repeat(24_700),
        toolCalls: [{ id: 'tc-1', name: 'word_count', args: {}, result: 'R'.repeat(400) }],
      });
      s.store.addMessage(sid, { role: 'user', content: '追问' });

      const res = await postChat(s.baseUrl, s.token, { sessionId: sid, text: '最新问题' });
      const evs = await readSse(res);
      expect(evs.at(-1)!.event).toBe('done');

      const prompt = model.doStreamCalls[0]!.prompt.filter((m) => m.role !== 'system');
      expect(prompt.map((m) => m.role)).toEqual(['user']);
      expect(promptText(prompt[0]!)).toBe('追问\n最新问题');
    } finally {
      await s.close();
    }
  });

  /** 建一个带 `/chapters/tmp` 声口档案的临时作品目录；返回该目录（用例 finally 里清理）。 */
  function makeWorkDir(styleSummary?: string): string {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-chat-data-'));
    if (styleSummary !== undefined) {
      fs.mkdirSync(path.join(workDir, '.novel'), { recursive: true });
      fs.writeFileSync(path.join(workDir, '.novel', 'style.md'), styleSummary, 'utf8');
    }
    return workDir;
  }

  /** 含 ledger_chapter_slice 的 domain 工具集（与 review 测试同口径：本地工具直接返回对象）。 */
  function chapterSliceTools(
    slice: string,
    execute?: (input: unknown) => Promise<unknown>
  ): ToolSet {
    const tools: Record<string, unknown> = {
      ledger_chapter_slice: {
        description: '按章裁剪账本切片',
        inputSchema: z.object({ workDir: z.string(), chapterRelPath: z.string() }),
        execute:
          execute ??
          (async () => ({
            found: true,
            slice,
            chapterTitle: '第一章',
            ledger: {},
          })),
      },
    };
    return tools as unknown as ToolSet;
  }

  it('数据层注入：style.md 声口摘要 + 章挂载 + 账本切片工具 → 系统提示含「声口摘要」「本章账本切片」', async () => {
    const workDir = makeWorkDir('## 摘要\n\n冷峻克制，惜字如金。');
    const ledgerExecute = vi.fn(async () => ({
      found: true,
      slice: '第一〇一则：少年拔剑  15:00\n第一〇二则：少年收剑  15:02',
      chapterTitle: '第一章',
      ledger: {},
    }));
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model, tools: chapterSliceTools('', ledgerExecute) });
    try {
      const res = await postChat(s.baseUrl, s.token, {
        text: '这章节奏如何',
        workDir,
        chapter: 'manuscript/第1章.md',
      });
      expect(res.status).toBe(200);
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const sysText = promptText(sys!);
      // 声口摘要
      expect(sysText).toContain('## 声口摘要');
      expect(sysText).toContain('冷峻克制，惜字如金。');
      // 本章账本切片
      expect(sysText).toContain('## 本章账本切片(第一章)');
      expect(sysText).toContain('仅含与当前章相关的账本条目，非全书。');
      expect(sysText).toContain('第一〇一则');
      expect(sysText).toContain('第一〇二则');
      expect(ledgerExecute).toHaveBeenCalledWith(
        { workDir, chapterRelPath: 'manuscript/第1章.md' },
        expect.objectContaining({ toolCallId: 'chat-ledger-chapter-slice' })
      );
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('数据层：无 chapter 字段 → 只注声口摘要，不注账本切片', async () => {
    const workDir = makeWorkDir('## 摘要\n\n沉郁内敛。');
    const ledgerExecute = vi.fn(async () => ({ found: true, slice: '不应出现', chapterTitle: '第一章' }));
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model, tools: chapterSliceTools('', ledgerExecute) });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '整体基调', workDir });
      expect(res.status).toBe(200);
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const sysText = promptText(sys!);
      expect(sysText).toContain('## 声口摘要');
      expect(sysText).not.toContain('## 本章账本切片');
      expect(ledgerExecute).not.toHaveBeenCalled();
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('数据层：style.md 不存在 → 不注声口摘要（账本切片照注）', async () => {
    const workDir = makeWorkDir(); // 无 style.md
    const ledgerExecute = vi.fn(async () => ({ found: true, slice: '账本目录', chapterTitle: '第一章' }));
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model, tools: chapterSliceTools('', ledgerExecute) });
    try {
      const res = await postChat(s.baseUrl, s.token, {
        text: '这章账本如何',
        workDir,
        chapter: 'manuscript/第1章.md',
      });
      expect(res.status).toBe(200);
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const sysText = promptText(sys!);
      expect(sysText).not.toContain('## 声口摘要');
      expect(sysText).toContain('## 本章账本切片(第一章)');
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('数据层：ledger_chapter_slice 抛错 → warn 降级跳过，不阻断聊天（不 5xx，照常 done）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const workDir = makeWorkDir('## 摘要\n\n冷峻克制。');
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({
      modelForTier: () => model,
      tools: chapterSliceTools('', async () => {
        throw new Error('mock 账本切片失败');
      }),
    });
    try {
      const res = await postChat(s.baseUrl, s.token, {
        text: '这章账本如何',
        workDir,
        chapter: 'manuscript/第1章.md',
      });
      expect(res.status).toBe(200);
      const events = await readSse(res);
      expect(events.at(-1)!.event).toBe('done'); // 不 5xx，聊天照常
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const sysText = promptText(sys!);
      expect(sysText).not.toContain('## 本章账本切片');
      expect(sysText).toContain('## 声口摘要'); // 声口摘要照常注入
      expect(warn).toHaveBeenCalled(); // 工具失败已 warn 降级
    } finally {
      warn.mockRestore();
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('数据层：tools 缺 ledger_chapter_slice（无 MCP 连接）→ warn 降级跳过账本切片', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const workDir = makeWorkDir('## 摘要\n\n冷峻克制。');
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model, tools: {} }); // 空工具集：无 ledger_chapter_slice
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '这段怎么改', workDir, chapter: 'manuscript/第1章.md' });
      expect(res.status).toBe(200);
      const events = await readSse(res);
      expect(events.at(-1)!.event).toBe('done');
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const sysText = promptText(sys!);
      expect(sysText).not.toContain('## 本章账本切片');
      expect(sysText).toContain('## 声口摘要'); // 声口摘要不依赖工具，照常注入
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('数据层：账本切片工具执行后 tools 照常注入 streamText（新 tools 合并，不覆盖既有领域工具）', async () => {
    const workDir = makeWorkDir('## 摘要\n\n冷峻克制。');
    const model = stepModel([
      toolCallResult('tc-1', 'word_count', { relPath: 'ch01.md' }),
      textResult(['共 42 字。']),
    ]);
    const s = await startTestServer({
      modelForTier: () => model,
      tools: { ...domainTools, ...chapterSliceTools('', async () => ({ found: true, slice: '账本', chapterTitle: '第一章' })) },
    });
    try {
      const res = await postChat(s.baseUrl, s.token, {
        text: '统计字数',
        workDir,
        chapter: 'manuscript/第1章.md',
      });
      const events = await readSse(res);
      expect(events.map((e) => e.event)).toEqual(['tool-call', 'tool-result', 'text-delta', 'done']);
      // 系统提示仍含账本切片（数据层注入不覆盖既有领域工具）
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      expect(promptText(sys!)).toContain('## 本章账本切片(第一章)');
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('本地工具 stage_chapter_proposal：body 带 chapter、模型调（mode=append）→ 候选落库 kind=append', async () => {
    const model = stepModel([
      toolCallResult('tc-stage', 'stage_chapter_proposal', { proposed: '续写内容', mode: 'append' }),
      textResult(['已送进暂存区。']),
    ]);
    // 不注入 MCP tools → 同时验证 MCP 断连时本地工具仍可用
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '续写第二章', chapter: 'manuscript/第2章.md' });
      expect(res.status).toBe(200);
      const events = await readSse(res);
      const names = events.map((e) => e.event);
      expect(names).toContain('tool-call');
      expect(names).toContain('tool-result');
      expect(names[names.length - 1]).toBe('done');

      const toolCall = events.find((e) => e.event === 'tool-call')!.data;
      expect(toolCall.name).toBe('stage_chapter_proposal');
      expect(toolCall.args).toEqual({ proposed: '续写内容', mode: 'append' });
      const toolResult = events.find((e) => e.event === 'tool-result')!.data;
      expect(String(toolResult.result)).toContain('已进暂存区');
      expect(String(toolResult.result)).toContain('候选 id');

      // 候选恰好一条：kind=append、chapter=body 的 chapter、sessionId=会话 id、proposed 正确
      const list = s.candidates.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.kind).toBe('append');
      expect(list[0]!.chapter).toBe('manuscript/第2章.md');
      expect(list[0]!.original).toBe(''); // append 不需要锚定原文
      expect(list[0]!.proposed).toBe('续写内容');
      const sessionId = events[names.length - 1]!.data.sessionId as string;
      expect(list[0]!.sessionId).toBe(sessionId);
    } finally {
      await s.close();
    }
  });

  it('本地工具 stage_chapter_proposal：body 与参数都无 chapter → 引导文本，候选不落库', async () => {
    const model = stepModel([
      toolCallResult('tc-2', 'stage_chapter_proposal', { proposed: '内容' }), // mode 缺省 append
      textResult(['好，我去查一下章节。']),
    ]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '帮我写一段' }); // body 不带 chapter
      const events = await readSse(res);
      const toolResult = events.find((e) => e.event === 'tool-result');
      expect(toolResult).toBeDefined();
      expect(String(toolResult!.data.result)).toContain('list_structure'); // 引导用 list_structure 查目标章
      expect(s.candidates.list()).toHaveLength(0); // 未落库
    } finally {
      await s.close();
    }
  });

  it('本地工具 stage_chapter_proposal：mode=replace 缺 original → 报错文本，候选不落库', async () => {
    const model = stepModel([
      toolCallResult('tc-3', 'stage_chapter_proposal', { proposed: '改写', mode: 'replace' }),
      textResult(['那我补一下锚定原文。']),
    ]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '改写这段', chapter: 'manuscript/第1章.md' });
      const events = await readSse(res);
      const toolResult = events.find((e) => e.event === 'tool-result');
      expect(toolResult).toBeDefined();
      expect(String(toolResult!.data.result)).toContain('original'); // 提示需提供锚定原文
      expect(String(toolResult!.data.result)).toContain('未创建候选');
      expect(s.candidates.list()).toHaveLength(0); // 未落库
    } finally {
      await s.close();
    }
  });
});