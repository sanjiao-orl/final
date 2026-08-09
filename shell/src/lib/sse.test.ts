// 测试：SSE 帧解析（注释帧/多帧/半帧保留）与 DeltaBatcher 批次节奏（30–50ms 纪律的落实件）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeltaBatcher, parseSseFrames, TOKEN_BATCH_MS } from './sse.js';

describe('parseSseFrames', () => {
  it('解析 event+data 帧，丢弃注释帧（:ok 保活）', () => {
    const buf = ':ok\n\nevent: text-delta\ndata: {"delta":"你"}\n\n';
    const { frames, rest } = parseSseFrames(buf);
    expect(rest).toBe('');
    expect(frames).toEqual([{ event: 'text-delta', data: { delta: '你' } }]);
  });

  it('半帧留在 rest，下次拼接后继续解析', () => {
    const first = parseSseFrames('event: done\ndata: {"sessionId":"s1"');
    expect(first.frames).toEqual([]);
    expect(first.rest).toContain('sessionId');
    const second = parseSseFrames(first.rest + '}\n\n');
    expect(second.frames).toEqual([{ event: 'done', data: { sessionId: 's1' } }]);
    expect(second.rest).toBe('');
  });

  it('多帧一次切出；无 event 行默认 message；非法 JSON 帧跳过', () => {
    const buf =
      'data: {"a":1}\n\n' +
      'event: error\ndata: {坏JSON}\n\n' +
      'event: done\ndata: {"ok":true}\n\n';
    const { frames } = parseSseFrames(buf);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ event: 'message', data: { a: 1 } });
    expect(frames[1]).toEqual({ event: 'done', data: { ok: true } });
  });
});

describe('DeltaBatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('间隔内多个 delta 合并为一次吐出（不逐 token）', () => {
    const out: string[] = [];
    const b = new DeltaBatcher((t) => out.push(t));
    b.push('你');
    b.push('好');
    b.push('，');
    expect(out).toEqual([]); // 未到时点不吐
    vi.advanceTimersByTime(TOKEN_BATCH_MS);
    expect(out).toEqual(['你好，']);
    b.dispose();
  });

  it('每批次间隔后重新起计时', () => {
    const out: string[] = [];
    const b = new DeltaBatcher((t) => out.push(t));
    b.push('甲');
    vi.advanceTimersByTime(TOKEN_BATCH_MS);
    b.push('乙');
    vi.advanceTimersByTime(TOKEN_BATCH_MS);
    expect(out).toEqual(['甲', '乙']);
    b.dispose();
  });

  it('flushNow 立即吐出并清计时；dispose 兜底不丢末尾', () => {
    const out: string[] = [];
    const b = new DeltaBatcher((t) => out.push(t));
    b.push('末尾');
    b.flushNow();
    expect(out).toEqual(['末尾']);
    b.push('再末');
    b.dispose();
    expect(out).toEqual(['末尾', '再末']);
    // dispose 后不再接受
    b.push('丢弃');
    vi.advanceTimersByTime(TOKEN_BATCH_MS * 2);
    expect(out).toEqual(['末尾', '再末']);
  });

  it('批次间隔在 30–50ms 纪律区间内', () => {
    expect(TOKEN_BATCH_MS).toBeGreaterThanOrEqual(30);
    expect(TOKEN_BATCH_MS).toBeLessThanOrEqual(50);
  });
});
