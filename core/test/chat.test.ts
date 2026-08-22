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

/** 轮询等待条件成立（弹锁/落库异步时序用），超时抛错。 */
async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 15));
  }
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

  // CI 双核 runner 上落库 60 条+全管道可超 vitest 默认 5s（实测 11.5s），显式放宽
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
  }, 20_000);

  it('回放字符预算：历史超 40k 字符只回放最近片段，截断后从 user 开始', async () => {
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const sid = s.store.createSession('预算').id;
      s.store.addMessage(sid, { role: 'user', content: 'A'.repeat(30_000) });
      s.store.addMessage(sid, { role: 'assistant', content: 'B'.repeat(30_000) });
      // 从最新往回：assistant 30k ≤ 40k 保留；user 30k 会超预算被截；回放 [assistant, user] 首条 assistant 被裁
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

  it('工具结果落库：长结果原样落库（不再 500 截断），超 20k 才截断并加省略标注', async () => {
    const model = stepModel([
      toolCallResult('tc-1', 'long_result', {}),
      textResult(['完成']),
    ]);
    const longResultTools: ToolSet = {
      long_result: tool({
        description: '返回长结果',
        inputSchema: z.object({}),
        execute: async () => 'L'.repeat(5_000),
      }),
    };
    const s = await startTestServer({ modelForTier: () => model, tools: longResultTools });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '执行长结果工具' });
      const events = await readSse(res);
      expect(events.at(-1)!.event).toBe('done');

      const sessionId = events.at(-1)!.data.sessionId as string;
      const assistant = s.store.listMessages(sessionId).at(-1)!;
      // 5000 字符全量落库，无截断标注
      expect(assistant.toolCalls).toEqual([
        { id: 'tc-1', name: 'long_result', args: {}, result: 'L'.repeat(5_000) },
      ]);
    } finally {
      await s.close();
    }
  });

  it('工具结果落库防爆：单条结果超 20k 截断并加省略标注', async () => {
    const model = stepModel([
      toolCallResult('tc-1', 'long_result', {}),
      textResult(['完成']),
    ]);
    const longResultTools: ToolSet = {
      long_result: tool({
        description: '返回超长结果',
        inputSchema: z.object({}),
        execute: async () => 'L'.repeat(25_000),
      }),
    };
    const s = await startTestServer({ modelForTier: () => model, tools: longResultTools });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '执行超长结果工具' });
      const events = await readSse(res);
      expect(events.at(-1)!.event).toBe('done');

      const sessionId = events.at(-1)!.data.sessionId as string;
      const assistant = s.store.listMessages(sessionId).at(-1)!;
      expect(assistant.toolCalls).toEqual([
        {
          id: 'tc-1',
          name: 'long_result',
          args: {},
          result: 'L'.repeat(20_000) + '\n…（已截断，可再调工具取全量）',
        },
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

  it('回放工具结果截断分档：非内容类工具最多回放 500 字符并加省略标注', async () => {
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
          output: { type: 'text', value: 'R'.repeat(500) + '\n…（已截断，可再调工具取全量）' },
        },
      ]);
    } finally {
      await s.close();
    }
  });

  it('回放工具结果截断分档：内容类工具(read_chapter)回放 3000 字符并加省略标注', async () => {
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const sid = s.store.createSession('内容档截断').id;
      s.store.addMessage(sid, { role: 'user', content: '第一问' });
      s.store.addMessage(sid, {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc-1', name: 'read_chapter', args: { relPath: 'ch01.md' }, result: 'R'.repeat(10_000) }],
      });
      s.store.addMessage(sid, { role: 'user', content: '追问' });

      const res = await postChat(s.baseUrl, s.token, { sessionId: sid, text: '最新问题' });
      const evs = await readSse(res);
      expect(evs.at(-1)!.event).toBe('done');

      const prompt = model.doStreamCalls[0]!.prompt.filter((m) => m.role !== 'system');
      const toolMsg = prompt.find((m) => m.role === 'tool')!;
      expect(toolMsg.content).toEqual([
        {
          type: 'tool-result',
          toolCallId: 'tc-1',
          toolName: 'read_chapter',
          output: { type: 'text', value: 'R'.repeat(3_000) + '\n…（已截断，可再调工具取全量）' },
        },
      ]);
    } finally {
      await s.close();
    }
  });

  it('回放结果计入字符预算：正文+结果超 40k 时整组裁掉，不留孤儿工具消息', async () => {
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const sid = s.store.createSession('结果预算').id;
      s.store.addMessage(sid, { role: 'user', content: '第一问' });
      s.store.addMessage(sid, {
        role: 'assistant',
        content: 'B'.repeat(39_700),
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

  it('姿态层：body 带 persona → 系统提示含「## 当前角色」与角色正文，插在契约层之后、数据层之前', async () => {
    const workDir = makeWorkDir('## 摘要\n\n冷峻克制。');
    const model = stepModel([textResult(['好的。'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '这章怎么改', workDir, persona: '责编' });
      expect(res.status).toBe(200);
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const sysText = promptText(sys!);
      expect(sysText).toContain('## 当前角色');
      expect(sysText).toContain('有据'); // 责编正文特征
      // 分层顺序（决策 0010）：契约层（skill 清单）→ 姿态层（当前角色）→ 数据层（声口摘要）
      expect(sysText.indexOf('## 当前角色')).toBeGreaterThan(sysText.indexOf('## 可用 skill'));
      expect(sysText.indexOf('## 声口摘要')).toBeGreaterThan(sysText.indexOf('## 当前角色'));
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('姿态层：书级 persona 同名遮蔽 app 级 → 注入书级正文', async () => {
    const workDir = makeWorkDir();
    fs.mkdirSync(path.join(workDir, '.novel', 'personas'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, '.novel', 'personas', '责编.md'),
      '---\nkind: persona\nname: 责编\ndescription: 书级\n---\n书级责编正文:只管节奏。',
      'utf8'
    );
    const model = stepModel([textResult(['好的。'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: 'hi', workDir, persona: '责编' });
      expect(res.status).toBe(200);
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const sysText = promptText(sys!);
      expect(sysText).toContain('## 当前角色');
      expect(sysText).toContain('书级责编正文');
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('姿态层：persona 按名找不到 → warn 且零注入（无「## 当前角色」）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = stepModel([textResult(['好的。'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: 'hi', persona: '不存在的角色' });
      expect(res.status).toBe(200);
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      expect(promptText(sys!)).not.toContain('## 当前角色');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await s.close();
    }
  });

  it('姿态层：body 不带 persona → 零注入（无「## 当前角色」）', async () => {
    const model = stepModel([textResult(['好的。'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: 'hi' });
      expect(res.status).toBe(200);
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      expect(promptText(sys!)).not.toContain('## 当前角色');
    } finally {
      await s.close();
    }
  });

  it('姿态层：persona 含控制字符 → 400（注入面拒绝破出提示行）', async () => {
    const s = await startTestServer();
    try {
      const res = await postChat(s.baseUrl, s.token, { text: 'hi', persona: '责编\n注入' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('控制字符');
    } finally {
      await s.close();
    }
  });

  /** 含 decision_tail 的领域工具集（碰撞模式讨论沉淀注入；execute 缺省直接返回 tail）。 */
  function decisionTailTools(
    tail: { total: number; lines: string[] },
    execute?: (input: unknown) => Promise<unknown>
  ): ToolSet {
    const tools: Record<string, unknown> = {
      decision_tail: {
        description: '检索最近裁决摘要',
        inputSchema: z.object({ workDir: z.string(), chapter: z.string().optional(), limit: z.number().optional() }),
        execute:
          execute ??
          (async () => tail),
      },
    };
    return tools as unknown as ToolSet;
  }

  it('碰撞模式：mode=collide → 系统提示含「## 碰撞协议」与四标题契约字样', async () => {
    const workDir = makeWorkDir();
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '这个设定互相打架吗', workDir, mode: 'collide' });
      expect(res.status).toBe(200);
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const sysText = promptText(sys!);
      expect(sysText).toContain('## 碰撞协议');
      expect(sysText).toContain('## 方案');
      expect(sysText).toContain('## 漏洞');
      expect(sysText).toContain('## 反方');
      expect(sysText).toContain('## 裁决');
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('碰撞模式：不传 mode → 系统提示不含「碰撞协议」', async () => {
    const workDir = makeWorkDir();
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '这段怎么改', workDir }); // 不传 mode
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      expect(promptText(sys!)).not.toContain('## 碰撞协议');
      expect(promptText(sys!)).not.toContain('## 讨论沉淀');
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('碰撞模式沉淀：decision_tail 返回 3 条 → 系统提示含「## 讨论沉淀」与三行内容', async () => {
    const workDir = makeWorkDir();
    const lines = ['D-001|放行|节奏前置|理由A|第1章', 'D-002|驳回|反派动机|理由B|第2章', 'D-003|搁置|伏笔密度|理由C|第3章'];
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model, tools: decisionTailTools({ total: 3, lines }) });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '碰撞', workDir, mode: 'collide' });
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const sysText = promptText(sys!);
      expect(sysText).toContain('## 讨论沉淀（最近裁决）');
      expect(sysText).toContain('D-001');
      expect(sysText).toContain('D-002');
      expect(sysText).toContain('D-003');
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('碰撞模式沉淀：decision_tail 工具缺失 → warn 降级零注入，不阻断聊天', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const workDir = makeWorkDir();
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model, tools: {} }); // 空工具集：无 decision_tail
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '碰撞', workDir, mode: 'collide' });
      expect(res.status).toBe(200);
      const events = await readSse(res);
      expect(events.at(-1)!.event).toBe('done');
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      expect(promptText(sys!)).not.toContain('## 讨论沉淀');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('碰撞模式沉淀：decision_tail 返回 total:0/lines:[] → 零注入', async () => {
    const workDir = makeWorkDir();
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model, tools: decisionTailTools({ total: 0, lines: [] }) });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '碰撞', workDir, mode: 'collide' });
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      expect(promptText(sys!)).not.toContain('## 讨论沉淀');
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('碰撞模式沉淀：非 collide 即使 decision_tail 在场也零注入，且 execute 未被调用', async () => {
    const execute = vi.fn(async () => ({ total: 3, lines: ['D-001|放行'] }));
    const workDir = makeWorkDir();
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model, tools: decisionTailTools({ total: 3, lines: ['D-001|放行'] }, execute) });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '这段怎么改', workDir }); // 不传 mode
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      expect(promptText(sys!)).not.toContain('## 讨论沉淀');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('碰撞模式沉淀：传 chapter → decision_tail execute 入参含 chapter', async () => {
    const execute = vi.fn(async () => ({ total: 2, lines: ['D-001|放行'] }));
    const workDir = makeWorkDir();
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model, tools: decisionTailTools({ total: 2, lines: ['D-001|放行'] }, execute) });
    try {
      const res = await postChat(s.baseUrl, s.token, {
        text: '碰撞',
        workDir,
        mode: 'collide',
        chapter: 'manuscript/第1章.md',
      });
      await readSse(res);
      expect(execute).toHaveBeenCalledWith(
        { workDir, limit: 20, chapter: 'manuscript/第1章.md' },
        expect.objectContaining({ toolCallId: 'chat-decision-tail' })
      );
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('碰撞模式沉淀：lines 合并超 1500 → 截断加标注，正文不超预算上限；total>lines 末尾挂条数说明', async () => {
    const workDir = makeWorkDir();
    const lines = ['长'.repeat(800), '长'.repeat(800)]; // join 1601 > 1500
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model, tools: decisionTailTools({ total: 100, lines }) });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '碰撞', workDir, mode: 'collide' });
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const sysText = promptText(sys!);
      expect(sysText).toContain('…（已截断，完整记录见 editorial_notes/decisions.md）');
      // 截断后注入正文不超预算上限：lines 全部由「长」组成，统计出现次数即正文长度
      const longCount = (sysText.match(/长/g) ?? []).length;
      expect(longCount).toBeLessThanOrEqual(1500);
      // total > lines.length → 节末尾追加条数摘要
      expect(sysText).toContain('（共 100 条，以上为摘要）');
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('契约层预算：skill 清单超 2000 字符 → 截断加省略标注（不再零预算零截断）', async () => {
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model });
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-chat-skills-'));
    fs.mkdirSync(path.join(workDir, '.novel', 'skills'), { recursive: true });
    const bigDescription = '长'.repeat(3_000);
    fs.writeFileSync(
      path.join(workDir, '.novel', 'skills', 'big.md'),
      `---\nkind: skill\nname: 大技能\ndescription: ${bigDescription}\n---\n正文`,
      'utf8'
    );
    try {
      const res = await postChat(s.baseUrl, s.token, { text: 'hi', workDir });
      expect(res.status).toBe(200);
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const sysText = promptText(sys!);
      expect(sysText).toContain('## 可用 skill');
      expect(sysText).toContain('…（skill 清单超 2000 字符，已截断）');
      // 截断按整段清单字符数计（app 级预置 skill 行在前，精确余量随环境变）：大段正文只保留前缀片段
      expect(sysText.includes('长'.repeat(1_000))).toBe(true);
      expect(sysText.includes('长'.repeat(2_501))).toBe(false);
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('姿态层预算：persona 正文超 2000 字符 → 截断加省略标注', async () => {
    const workDir = makeWorkDir();
    fs.mkdirSync(path.join(workDir, '.novel', 'personas'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, '.novel', 'personas', '大角色.md'),
      `---\nkind: persona\nname: 大角色\n---\n${'角'.repeat(3_000)}`,
      'utf8'
    );
    const model = stepModel([textResult(['好的。'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: 'hi', workDir, persona: '大角色' });
      expect(res.status).toBe(200);
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const sysText = promptText(sys!);
      expect(sysText).toContain('## 当前角色');
      expect(sysText).toContain('…（角色正文超 2000 字符，已截断）');
      // 截断后正文不超预算上限：2000 连「角」在，2001 连「角」不在
      expect(sysText.includes('角'.repeat(2_000))).toBe(true);
      expect(sysText.includes('角'.repeat(2_001))).toBe(false);
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  /** 永挂直到收到 abort 的账本切片工具（domain 数据层挂起仿真，与 @ai-sdk/mcp 同款中止行为：reject）；记录收到的信号供断言。 */
  function hangingSliceTools(seen: { abortSignal?: AbortSignal | undefined }): ToolSet {
    return {
      ledger_chapter_slice: {
        description: '按章裁剪账本切片',
        inputSchema: z.object({ workDir: z.string(), chapterRelPath: z.string() }),
        execute: async (_input: unknown, options: { abortSignal?: AbortSignal }) => {
          seen.abortSignal = options?.abortSignal;
          return new Promise((_resolve, reject) => {
            options?.abortSignal?.addEventListener('abort', () => reject(options.abortSignal!.reason));
          });
        },
      },
    } as unknown as ToolSet;
  }

  it('数据层注入挂起：按独立注入超时降级跳过（不等满 LLM 超时），warn 归因为数据层而非 LLM 请求超时', async () => {
    vi.stubEnv('DATA_INJECT_TIMEOUT_SECONDS', '0.3');
    vi.stubEnv('LLM_TIMEOUT_SECONDS', '600');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const workDir = makeWorkDir('## 摘要\n\n冷峻克制。');
    const seen: { abortSignal?: AbortSignal } = {};
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model, tools: hangingSliceTools(seen) });
    try {
      const startedAt = Date.now();
      const res = await postChat(s.baseUrl, s.token, { text: '这章如何', workDir, chapter: 'manuscript/第1章.md' });
      expect(res.status).toBe(200);
      const events = await readSse(res);
      // 聊天照常完成（done 而非 error），且远快于 LLM 超时——注入挂起只损失该节
      expect(events.at(-1)!.event).toBe('done');
      expect(Date.now() - startedAt).toBeLessThan(10_000);

      // 独立注入信号确实送达 MCP 工具调用（@ai-sdk/mcp 透传 abortSignal 的同款入参形态）
      expect(seen.abortSignal).toBeDefined();

      const warned = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      expect(warned).toContain('数据层注入超时');
      // 误归因口径是「LLM 请求超时（超过 N 秒）」——注入挂起不得再走这个文案
      expect(warned).not.toMatch(/LLM 请求超时（超过/);

      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      expect(promptText(sys!)).not.toContain('## 本章账本切片');
      expect(promptText(sys!)).toContain('## 声口摘要'); // 声口摘要不依赖工具，照常注入
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('数据层注入挂起（decision_tail）：同口径独立超时降级，warn 归因数据层', async () => {
    vi.stubEnv('DATA_INJECT_TIMEOUT_SECONDS', '0.3');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const workDir = makeWorkDir();
    const tools: ToolSet = {
      decision_tail: {
        description: '检索最近裁决摘要',
        inputSchema: z.object({ workDir: z.string(), limit: z.number().optional() }),
        execute: async (_input: unknown, options: { abortSignal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options?.abortSignal?.addEventListener('abort', () => reject(options.abortSignal!.reason));
          }),
      },
    } as unknown as ToolSet;
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model, tools });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '碰撞', workDir, mode: 'collide' });
      expect(res.status).toBe(200);
      const events = await readSse(res);
      expect(events.at(-1)!.event).toBe('done');
      const warned = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      expect(warned).toContain('decision_tail');
      expect(warned).toContain('数据层注入超时');
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      expect(promptText(sys!)).not.toContain('## 讨论沉淀');
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('同 session 并发：第二个 409；第一个完成后同会话可再发；不同 session 并发互不影响（P2 在飞锁）', async () => {
    let aborted = 0;
    const s = await startTestServer({ modelForTier: () => hangingModel(() => aborted++) });
    try {
      const sid = s.store.createSession('并发').id;
      const sid2 = s.store.createSession('并发B').id;
      const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` };
      const post = (id: string, text: string, signal?: AbortSignal) => {
        const init: RequestInit = { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: id, text }) };
        if (signal) init.signal = signal;
        return fetch(`${s.baseUrl}/v1/chat`, init);
      };

      // 第一发：hangingModel 永不主动结束，挂住在飞持有锁。落库用户消息在加锁之后，消息出现即锁已持。
      const ctrl1 = new AbortController();
      const p1 = post(sid, '第一发', ctrl1.signal);
      await waitFor(() => s.store.listMessages(sid).some((m) => m.role === 'user'));

      // 同 session 第二个并发 → 409，且被拒请求没往会话写消息（409 在落库前拦截）
      const res2 = await postChat(s.baseUrl, s.token, { sessionId: sid, text: '第二发' });
      expect(res2.status).toBe(409);
      expect(((await res2.json()) as { error: string }).error).toContain('正在进行的对话');
      expect(s.store.listMessages(sid).filter((m) => m.role === 'user')).toHaveLength(1);

      // 不同 session 并发互不影响：第二个会话不被 409 拦，能落库（拿到 200 与锁）
      const ctrl2 = new AbortController();
      const pB = post(sid2, '并发B', ctrl2.signal);
      await waitFor(() => s.store.listMessages(sid2).some((m) => m.role === 'user'));
      ctrl2.abort();
      await pB.catch(() => {});

      // 停止第一个（客户端断连触发服务端中止模型）→ 锁在 finally 释放
      ctrl1.abort();
      await p1.catch(() => {});
      await waitFor(() => aborted >= 1); // 服务端已处理中止
      await new Promise((r) => setTimeout(r, 150));

      // 第一个完成后同会话可再发：第三发不再 409，能落库（再次拿锁并挂住）
      const ctrl3 = new AbortController();
      const p3 = post(sid, '第三发', ctrl3.signal);
      await waitFor(() => s.store.listMessages(sid).filter((m) => m.role === 'user').length >= 2);
      ctrl3.abort();
      await p3.catch(() => {});
    } finally {
      await s.close();
    }
  });
});