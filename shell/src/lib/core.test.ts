// core.ts 单测：health() 与 SSE POST 中 AbortSignal 行为。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient } from './core.js';

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('CoreClient.health', () => {
  it('成功：解析 ok/version/protocol 字段', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true, version: '0.1.0', protocol: 1 }));
    const c = new CoreClient('http://127.0.0.1:1', 't');
    const h = await c.health();
    expect(h).toEqual({ ok: true, version: '0.1.0', protocol: 1 });
    expect(globalThis.fetch).toHaveBeenCalledWith('http://127.0.0.1:1/v1/health');
  });

  it('非 2xx：抛出带 status 的错误', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    const c = new CoreClient('http://127.0.0.1:1', 't');
    await expect(c.health()).rejects.toThrow('503');
  });
});

describe('CoreClient.chatStream abort', () => {
  it('流式期间 abort → reader 取消，promise 正常 resolve 不抛', async () => {
    // 构造一个需要主动消费的 stream：reader 不读则 enqueue 不会写入但 stream 不会被关闭；
    // 通过 abort 触发 reader.cancel 让 controller 关闭。
    const ac = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: unknown, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          ac.signal.addEventListener('abort', () => {
            try {
              controller.close();
            } catch {
              // ignore
            }
          });
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      );
    });
    const c = new CoreClient('http://127.0.0.1:1', 't');
    const outerAc = new AbortController();
    let aborted = false;
    outerAc.signal.addEventListener('abort', () => (aborted = true));
    const promise = c.chatStream(
      { text: 'x' },
      { onDelta: () => undefined },
      outerAc.signal,
    );
    // 立刻取消（reader.cancel 会让 controller 关闭，for 循环退出，promise resolve）
    queueMicrotask(() => outerAc.abort());
    await promise;
    expect(aborted).toBe(true);
    expect(fetchSignal?.aborted).toBe(true);
  });

  it('未传 signal：原行为保持（不取消）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('event: done\ndata: {"sessionId":"s","messageId":"m"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    const c = new CoreClient('http://127.0.0.1:1', 't');
    await c.chatStream({ text: 'x' }, { onDelta: () => undefined, onDone: () => undefined });
    // 不传 signal 时 init 不带 signal
    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit | undefined;
    expect(callArgs?.signal).toBeUndefined();
  });
});