// 测试共用工具：起一个真实 HTTP 服务（随机端口）、SSE 帧解析、mock 模型构造。
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV3, MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV3GenerateResult, LanguageModelV3StreamPart, LanguageModelV3StreamResult, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { ChatDeps } from '../src/chat.js';
import { createAppServer } from '../src/server.js';
import { CandidateStore } from '../src/candidate-store.js';
import { SessionStore } from '../src/session-store.js';
import { StatsStore } from '../src/stats-store.js';

export interface TestServer {
  baseUrl: string;
  token: string;
  store: SessionStore;
  candidates: CandidateStore;
  stats: StatsStore;
  close: () => Promise<void>;
}

export async function startTestServer(overrides: {
  modelForTier?: ChatDeps['modelForTier'];
  tools?: ChatDeps['tools'];
  toolsAvailable?: ChatDeps['toolsAvailable'];
  devEnabled?: boolean;
} = {}): Promise<TestServer> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'novel-core-test-'));
  const dbPath = path.join(dir, 'sessions.sqlite');
  const store = new SessionStore(dbPath);
  const candidates = new CandidateStore(dbPath);
  const stats = new StatsStore(dbPath);
  const token = randomUUID();
  const chat: ChatDeps = {
    store,
    candidates,
    modelForTier:
      overrides.modelForTier ??
      (() => {
        throw new Error('未注入 modelForTier');
      }),
    tools: overrides.tools,
  };
  if (overrides.toolsAvailable) chat.toolsAvailable = overrides.toolsAvailable;
  const server = createAppServer({
    token,
    store,
    chat,
    candidates,
    stats,
    rewrite: { modelForTier: chat.modelForTier },
    continue: { modelForTier: () => chat.modelForTier('background') },
    version: 'test',
    ...(overrides.devEnabled !== undefined ? { devEnabled: overrides.devEnabled } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    store,
    candidates,
    stats,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      candidates.close();
      stats.close();
    },
  };
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** 读取整个 SSE 响应，解析成事件数组（与 /dev 页同一套解析逻辑）。 */
export async function readSse(response: Response): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (t.startsWith('event:')) event = t.slice(6).trim();
        else if (t.startsWith('data:')) dataLines.push(t.slice(5).trim());
      }
      if (dataLines.length > 0) events.push({ event, data: JSON.parse(dataLines.join('\n')) });
    }
  }
  return events;
}

const EMPTY_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** 纯文本一步完成的 v3 流结果。 */
export function textResult(deltas: string[]): LanguageModelV3StreamResult {
  return {
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: 'text-start', id: 't1' });
        for (const delta of deltas) controller.enqueue({ type: 'text-delta', id: 't1', delta });
        controller.enqueue({ type: 'text-end', id: 't1' });
        controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: EMPTY_USAGE });
        controller.close();
      },
    }),
  };
}

/** 只发一个工具调用、等待工具执行的一步流。 */
export function toolCallResult(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>
): LanguageModelV3StreamResult {
  return {
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) });
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: EMPTY_USAGE,
        });
        controller.close();
      },
    }),
  };
}

/** 多步对话：按调用次数依次返回结果数组里的流。 */
export function stepModel(results: LanguageModelV3StreamResult[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({ doStream: results });
}

/** 纯文本一步完成的 v3 generate 结果（generateText 走 doGenerate）。 */
export function generateResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: EMPTY_USAGE,
    warnings: [],
  };
}

/** 单步返回 doGenerate 文本的 mock 模型（generateText 用；按调用次数依次取 texts）。 */
export function generateModel(texts: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({ doGenerate: texts.map(generateResult) });
}

/**
 * 仿真真实 provider 的 v4 模型：发一个 text-delta 后挂起，收到 abortSignal 时 error 掉流（provider 断连行为）。
 * 用于断连测试：onAbort 置位即证明 LLM 请求被中止。
 */
export function hangingModel(onAbort: () => void): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 't1' });
          controller.enqueue({ type: 'text-delta', id: 't1', delta: '第一段' });
          options.abortSignal?.addEventListener('abort', () => {
            onAbort();
            controller.error(new Error('provider stream aborted'));
          });
        },
      });
      return { stream };
    },
  });
}