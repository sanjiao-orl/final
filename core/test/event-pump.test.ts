// 测试：event_pump（D4 单一发射点）——帧写序 = 发射序（多生产者并发不交错）、
// end 后拒绝新帧（done/error 恒为最后一帧）、end 排在已入队帧之后、断连不炸。
import { describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { EventPump } from '../src/event-pump.js';

/** 只暴露 EventPump 关心的 ServerResponse 面：write/end 捕获 + 连接态标记。 */
function fakeRes(): {
  res: ServerResponse;
  writes: string[];
  ended: () => boolean;
} {
  const writes: string[] = [];
  const state = { ended: false, destroyed: false };
  const res = {
    destroyed: false,
    writableEnded: false,
    write: (s: string) => {
      if (state.ended) throw new Error('write after end');
      writes.push(s);
      return true;
    },
    end: () => {
      state.ended = true;
    },
    // EventPump 只读这两面；head 由 startSse 写（真实服务端路径），这里直造帧
    writeHead: vi.fn(),
    on: vi.fn(),
  } as unknown as ServerResponse;
  Object.defineProperty(res, 'destroyed', { get: () => state.destroyed });
  Object.defineProperty(res, 'writableEnded', { get: () => state.ended });
  return { res, writes, ended: () => state.ended };
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
});
