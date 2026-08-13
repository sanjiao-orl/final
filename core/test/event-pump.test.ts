// 测试：event_pump（D4 单一发射点）——帧写序 = 发射序（多生产者并发不交错）、
// end 后拒绝新帧（done/error 恒为最后一帧）、end 排在已入队帧之后、断连不炸、
// 背压等 drain、写失败后 end 仍能收尾。
import { describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { EventPump } from '../src/event-pump.js';

interface FakeRes {
  res: ServerResponse;
  writes: string[];
  ended: () => boolean;
  setDestroyed: (value: boolean) => void;
  fireError: (err: Error) => void;
  fireClose: () => void;
  fireDrain: () => void;
}

/** 只暴露 EventPump 关心的 ServerResponse 面：write/end 捕获 + 连接态标记 + on/once/off 事件面。 */
function fakeRes(options: { writeImpl?: (s: string) => boolean } = {}): FakeRes {
  const writes: string[] = [];
  const state = { ended: false, destroyed: false };
  const listeners = new Map<string, Array<(arg?: unknown) => void>>();

  const addListener = (event: string, listener: (arg?: unknown) => void): void => {
    const set = listeners.get(event) ?? [];
    set.push(listener);
    listeners.set(event, set);
  };
  const removeListener = (event: string, listener: (arg?: unknown) => void): void => {
    const set = listeners.get(event);
    if (!set) return;
    listeners.set(event, set.filter((l) => l !== listener));
  };
  const fire = (event: string, arg?: unknown): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(arg);
  };

  const res = {
    destroyed: false,
    writableEnded: false,
    write: (s: string) => {
      if (state.ended) throw new Error('write after end');
      if (options.writeImpl) return options.writeImpl(s);
      writes.push(s);
      return true;
    },
    end: () => {
      state.ended = true;
    },
    on: (event: string, listener: (arg?: unknown) => void) => addListener(event, listener),
    off: (event: string, listener: (arg?: unknown) => void) => removeListener(event, listener),
    once: (event: string, listener: (arg?: unknown) => void) => {
      const wrapper = (arg?: unknown): void => {
        removeListener(event, wrapper);
        listener(arg);
      };
      addListener(event, wrapper);
    },
    // EventPump 只读这两面；head 由 startSse 写（真实服务端路径），这里直造帧
    writeHead: vi.fn(),
  } as unknown as ServerResponse;
  Object.defineProperty(res, 'destroyed', { get: () => state.destroyed });
  Object.defineProperty(res, 'writableEnded', { get: () => state.ended });
  return {
    res,
    writes,
    ended: () => state.ended,
    setDestroyed: (value) => (state.destroyed = value),
    fireError: (err) => fire('error', err),
    fireClose: () => fire('close'),
    fireDrain: () => fire('drain'),
  };
}

describe('EventPump', () => {
  it('顺序发射：写序 = 发射序（同一生产者串行）', async () => {
    const { res, writes } = fakeRes();
    const pump = new EventPump(res);
    pump.emit('text-delta', { delta: '你' });
    pump.emit('text-delta', { delta: '好' });
    await pump.flush();
    expect(writes).toEqual([
      'event: text-delta\ndata: {"delta":"你"}\n\n',
      'event: text-delta\ndata: {"delta":"好"}\n\n',
    ]);
  });

  it('并发生产者不交错：异步乱序 emit 仍按发射序落盘', async () => {
    const { res, writes } = fakeRes();
    const pump = new EventPump(res);
    pump.emit('a', { i: 1 });
    pump.emit('b', { i: 2 });
    const late = Promise.resolve().then(() => pump.emit('c', { i: 3 }));
    const later = Promise.resolve().then(() => pump.emit('d', { i: 4 }));
    await Promise.all([late, later]);
    await pump.flush();
    expect(writes.map((w) => JSON.parse(w.split('data: ')[1]!).i)).toEqual([1, 2, 3, 4]);
  });

  it('end 排在已入队帧之后：先 emit 后 end，最后一帧仍是 done/error', async () => {
    const { res, writes, ended } = fakeRes();
    const pump = new EventPump(res);
    pump.emit('text-delta', { delta: '尾' });
    pump.emit('done', { sessionId: 's1', messageId: 'm1' });
    pump.end();
    await pump.flush();
    expect(ended()).toBe(true);
    expect(writes[writes.length - 1]).toBe('event: done\ndata: {"sessionId":"s1","messageId":"m1"}\n\n');
  });

  it('end 之后 emit 一律丢弃（结束事件之后不允许再发射）', async () => {
    const { res, writes } = fakeRes();
    const pump = new EventPump(res);
    pump.emit('done', { ok: true });
    pump.end();
    pump.emit('text-delta', { delta: '不该出现' });
    await pump.flush();
    expect(writes).toHaveLength(1);
  });

  it('绑定会话：sessionId 可读（按会话保序的绑定依据）', () => {
    const { res } = fakeRes();
    expect(new EventPump(res, 'session-1').sessionId).toBe('session-1');
    expect(new EventPump(res).sessionId).toBeUndefined();
  });

  it('背压：write 返回 false 时等 drain 后再写下一帧', async () => {
    let writable = false;
    const { res, writes, fireDrain } = fakeRes({
      writeImpl: (s) => {
        writes.push(s);
        return writable;
      },
    });
    const pump = new EventPump(res);
    pump.emit('a', { i: 1 });
    pump.emit('b', { i: 2 });
    await Promise.resolve();
    expect(writes).toHaveLength(1); // 第二帧被背压挡住
    writable = true;
    fireDrain();
    await pump.flush();
    expect(writes.map((w) => JSON.parse(w.split('data: ')[1]!).i)).toEqual([1, 2]);
  });

  it('写失败后：后续 done/error 终帧仍会写出，end 不挂起', async () => {
    let failNext = true;
    const { res, writes, ended } = fakeRes({
      writeImpl: (s) => {
        if (failNext) {
          failNext = false;
          throw new Error('socket 写失败');
        }
        writes.push(s);
        return true;
      },
    });
    const pump = new EventPump(res);
    pump.emit('text-delta', { delta: '半截' }); // 这次写失败
    pump.emit('error', { message: '模型调用失败' });
    pump.end();
    await pump.flush();
    expect(ended()).toBe(true);
    expect(writes).toEqual(['event: error\ndata: {"message":"模型调用失败"}\n\n']);
  });

  it('res error 有监听：连接错误不崩进程，后续写照常', async () => {
    const { res, writes, fireError } = fakeRes();
    const pump = new EventPump(res);
    expect(() => fireError(new Error('连接重置'))).not.toThrow();
    pump.emit('done', { ok: true });
    pump.end();
    await pump.flush();
    expect(writes).toHaveLength(1);
  });
});
