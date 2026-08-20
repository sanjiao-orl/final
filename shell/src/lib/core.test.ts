// core.ts 单测：health() 与 SSE POST 中 AbortSignal 行为 + 裸联调参数记忆（resolveBareParam）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient, resolveBareParam, LS_CORE_TOKEN_KEY, LS_CORE_WORKDIR_KEY } from './core.js';

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

describe('resolveBareParam（裸联调 token/workDir 记忆）', () => {
  it('query 优先（向后兼容）：不回落到 localStorage，也不写回', () => {
    const lsSet = vi.fn();
    const prompt = vi.fn();
    const v = resolveBareParam('coreToken', LS_CORE_TOKEN_KEY, 'p', {
      query: new URLSearchParams('?coreToken=from-query'),
      lsGet: () => 'from-ls',
      lsSet,
      prompt,
    });
    expect(v).toBe('from-query');
    expect(prompt).not.toHaveBeenCalled();
    expect(lsSet).not.toHaveBeenCalled();
  });

  it('query 缺省时回落 localStorage 记忆', () => {
    const v = resolveBareParam('coreToken', LS_CORE_TOKEN_KEY, 'p', {
      query: new URLSearchParams(),
      lsGet: () => 'from-ls',
      lsSet: vi.fn(),
      prompt: vi.fn(),
    });
    expect(v).toBe('from-ls');
  });

  it('query 与 localStorage 都缺省时 prompt 用户，并写入 localStorage', () => {
    const lsSet = vi.fn();
    const v = resolveBareParam('workDir', LS_CORE_WORKDIR_KEY, '请填目录', {
      query: new URLSearchParams(),
      lsGet: () => null,
      lsSet,
      prompt: () => 'C:/works/demo',
    });
    expect(v).toBe('C:/works/demo');
    expect(lsSet).toHaveBeenCalledWith(LS_CORE_WORKDIR_KEY, 'C:/works/demo');
  });

  it('用户取消 prompt → undefined，不写 localStorage', () => {
    const lsSet = vi.fn();
    const v = resolveBareParam('coreToken', LS_CORE_TOKEN_KEY, 'p', {
      query: new URLSearchParams(),
      lsGet: () => null,
      lsSet,
      prompt: () => null,
    });
    expect(v).toBeUndefined();
    expect(lsSet).not.toHaveBeenCalled();
  });
});

describe('CoreClient.rewriteStream（workDir 透传）', () => {
  it('workDir 进 POST /v1/rewrite 请求体，done 回传完整改写文本', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('event: done\ndata: {"text":"改写结果"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    const c = new CoreClient('http://127.0.0.1:1', 't');
    let received: string | undefined;
    await c.rewriteStream(
      { workDir: 'C:/works/demo', original: '旧文', instruction: '润色' },
      { onDelta: () => undefined, onDone: ({ text }) => (received = text) },
    );
    expect(received).toBe('改写结果');
    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(callArgs?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ workDir: 'C:/works/demo', original: '旧文', instruction: '润色' });
  });
});

describe('CoreClient.posture / review persona（决策 0010）', () => {
  it('getPosture：带 workDir 的 GET 请求，解析 personas/schemes/activeScheme', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        personas: [],
        schemes: [{ name: 'S', description: '', channels: { chat: '外婆' }, source: 'work' }],
        activeScheme: 'S',
      }),
    );
    const c = new CoreClient('http://127.0.0.1:1', 't');
    const r = await c.getPosture('C:/works/demo');
    expect(r.activeScheme).toBe('S');
    expect(r.schemes[0]!.channels.chat).toBe('外婆');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:1/v1/posture?workDir=C%3A%2Fworks%2Fdemo',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer t' }) }),
    );
  });

  it('review：persona 传入时进请求体；缺省不带', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ findings: [] }));
    const c = new CoreClient('http://127.0.0.1:1', 't');
    await c.review('C:/works/demo', 'manuscript/a.md', '刺猬');
    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(callArgs?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ workDir: 'C:/works/demo', chapterRelPath: 'manuscript/a.md', persona: '刺猬' });

    await c.review('C:/works/demo', 'manuscript/a.md');
    const body2 = JSON.parse(
      String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]?.body),
    ) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body2, 'persona')).toBe(false);
  });
});