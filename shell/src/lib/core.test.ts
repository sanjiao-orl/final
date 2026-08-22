// core.ts 单测：health() 与 SSE POST 中 AbortSignal 行为 + 裸联调参数记忆（resolveBareParam）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient, CoreNetworkError, resolveBareParam, LS_CORE_TOKEN_KEY, LS_CORE_WORKDIR_KEY } from './core.js';

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
  vi.useRealTimers();
});

/** fetch mock：永不 resolve，仅在 init.signal abort 时以对应 DOMException 拒绝（模拟挂死/超时/取消）。 */
function hangingFetch(onAbortName = 'AbortError'): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    return new Promise((_resolve, reject) => {
      const abort = (): void => reject(new DOMException('Aborted', onAbortName));
      if (!signal || signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  });
}

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
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:1/v1/health',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer t' }) }),
    );
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

describe('CoreClient 网络层错误提示（core 可能已退出）', () => {
  it('callTool：fetch 连不上（网络层）→ 抛 CoreNetworkError，消息自带可行动提示', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const c = new CoreClient('http://127.0.0.1:1', 't');
    await expect(c.callTool('word_count', {})).rejects.toThrow(CoreNetworkError);
    await expect(c.callTool('word_count', {})).rejects.toThrow('core 可能已退出');
    await expect(c.callTool('word_count', {})).rejects.toThrow('请到设置页重启 core');
  });

  it('callTool：HTTP 4xx/5xx（业务错误）→ 普通 Error，不带「core 可能已退出」提示', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ error: '参数缺失' }, 400));
    const c = new CoreClient('http://127.0.0.1:1', 't');
    const err = await c.callTool('word_count', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CoreNetworkError);
    const msg = err instanceof Error ? err.message : String(err);
    expect(msg).toContain('参数缺失');
    expect(msg).not.toContain('core 可能已退出');
  });

  it('chatStream：SSE 流网络层失败 → 抛 CoreNetworkError 带提示，业务 SSE error 事件走 onError 不带', async () => {
    // 网络层：fetch 拒绝
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('conn refused'));
    const c = new CoreClient('http://127.0.0.1:1', 't');
    await expect(c.chatStream({ text: 'x' }, { onDelta: () => undefined })).rejects.toThrow(CoreNetworkError);
    await expect(c.chatStream({ text: 'x' }, { onDelta: () => undefined })).rejects.toThrow('core 可能已退出');
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

describe('CoreClient.request 默认超时（挂死根因修复）', () => {
  it('callTool：默认 30s 无响应 → 抛「请求超时」清晰错误（非 CoreNetworkError）', async () => {
    vi.useFakeTimers();
    globalThis.fetch = hangingFetch();
    const c = new CoreClient('http://127.0.0.1:1', 't');
    const p = c.callTool('word_count', {});
    void p.catch(() => {});
    await vi.advanceTimersByTimeAsync(29_999);
    // 未到超时：仍挂起
    let settled = false;
    void p.then(() => (settled = true), () => (settled = true));
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CoreNetworkError); // 超时≠连不上，不带「core 可能已退出」
    expect((err as Error).message).toContain('请求超时');
    expect((err as Error).message).toContain('30 秒');
  });

  it('长任务可覆盖：review 传更大 timeoutMs，默认窗口内不误杀，覆盖窗口到点才报错', async () => {
    vi.useFakeTimers();
    globalThis.fetch = hangingFetch();
    const c = new CoreClient('http://127.0.0.1:1', 't');
    const p = c.review('C:/works/demo', 'manuscript/a.md', undefined, { timeoutMs: 120_000 });
    void p.catch(() => {});
    await vi.advanceTimersByTimeAsync(30_000); // 默认窗口已过：不误杀
    let settled = false;
    void p.then(() => (settled = true), () => (settled = true));
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(settled).toBe(true);
    await expect(p).rejects.toThrow('请求超时（超过 120 秒无响应）');
  });

  it('显式 signal 取消 → 抛「请求已取消」（区别于网络层错误）', async () => {
    globalThis.fetch = hangingFetch();
    const c = new CoreClient('http://127.0.0.1:1', 't');
    const ac = new AbortController();
    const p = c.review('C:/works/demo', 'manuscript/a.md', undefined, { signal: ac.signal });
    queueMicrotask(() => ac.abort());
    await expect(p).rejects.toThrow('请求已取消');
  });

  it('signal 已提前 aborted：直接走取消分支', async () => {
    globalThis.fetch = hangingFetch();
    const c = new CoreClient('http://127.0.0.1:1', 't');
    const ac = new AbortController();
    ac.abort();
    await expect(c.review('C:/works/demo', 'manuscript/a.md', undefined, { signal: ac.signal })).rejects.toThrow(
      '请求已取消',
    );
  });

  it('连不上仍是 CoreNetworkError（超时机制不影响原网络层口径）', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const c = new CoreClient('http://127.0.0.1:1', 't');
    await expect(c.listSessions()).rejects.toThrow(CoreNetworkError);
  });
});

describe('CoreClient.health 短超时（boot 握手防 HTTP 僵死永转）', () => {
  it('HTTP 僵死：5s 量级短超时报错而非永挂', async () => {
    vi.useFakeTimers();
    let fetchSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: unknown, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Timed Out', 'TimeoutError')));
      });
    });
    const c = new CoreClient('http://127.0.0.1:1', 't');
    const p = c.health();
    void p.catch(() => {});
    await vi.advanceTimersByTimeAsync(4_999);
    let settled = false;
    void p.then(() => (settled = true), () => (settled = true));
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(fetchSignal?.aborted).toBe(true);
    await expect(p).rejects.toThrow('请求超时（超过 5 秒无响应）');
  });
});

describe('SSE 干净断尾不算成功', () => {
  it('core 关流但未发 done/error 帧 → 抛错（静默当成功会让卡死零信号）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('event: text-delta\ndata: {"text":"片段"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    const c = new CoreClient('http://127.0.0.1:1', 't');
    const onDone = vi.fn();
    const onError = vi.fn();
    await expect(
      c.chatStream({ text: 'x' }, { onDelta: () => undefined, onDone, onError }),
    ).rejects.toThrow('SSE 流在完成前被关闭');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('rewriteStream / continueText 同口径：断尾抛错', async () => {
    const emptySse = (): Response =>
      new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(emptySse()));
    const c = new CoreClient('http://127.0.0.1:1', 't');
    await expect(
      c.rewriteStream({ original: 'a', instruction: 'b' }, { onDelta: () => undefined }),
    ).rejects.toThrow('未收到 done/error 帧');
    await expect(
      c.continueText({ context: 'c' }, { onText: () => undefined }),
    ).rejects.toThrow('未收到 done/error 帧');
  });

  it('收到 done 帧后关流：行为不变，正常完成不误报', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('event: done\ndata: {"sessionId":"s","messageId":"m"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    const c = new CoreClient('http://127.0.0.1:1', 't');
    const onDone = vi.fn();
    await c.chatStream({ text: 'x' }, { onDelta: () => undefined, onDone });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('abort 中断的流不受断尾检查影响：照旧 resolve 不抛', async () => {
    const ac = new AbortController();
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              ac.signal.addEventListener('abort', () => {
                try {
                  controller.close();
                } catch {
                  // ignore
                }
              });
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    );
    const c = new CoreClient('http://127.0.0.1:1', 't');
    const outerAc = new AbortController();
    const promise = c.chatStream({ text: 'x' }, { onDelta: () => undefined }, outerAc.signal);
    queueMicrotask(() => outerAc.abort());
    await promise; // 不应因断尾检查抛错
  });
});