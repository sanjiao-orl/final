/**
 * sse.ts —— SSE 帧解析与 text-delta 批次器（纯逻辑，node 环境可测）。
 * 纪律：token 不逐条进 store，一律经 DeltaBatcher 按 30–50ms 批次吐出。
 */

export interface SseFrame {
  event: string;
  data: unknown;
}

/** 从缓冲里切出完整 SSE 帧（\n\n 分隔）；注释帧（: 开头）与无 data 帧丢弃。 */
export function parseSseFrames(buf: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buf;
  let idx: number;
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.startsWith(':')) continue; // 注释帧（:ok 保活）
      if (t.startsWith('event:')) event = t.slice(6).trim();
      else if (t.startsWith('data:')) dataLines.push(t.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    try {
      frames.push({ event, data: JSON.parse(dataLines.join('\n')) });
    } catch {
      // 非法 JSON 帧跳过，不断流
    }
  }
  return { frames, rest };
}

/** token 批次间隔（30–50ms 区间取中值）。 */
export const TOKEN_BATCH_MS = 40;

/**
 * text-delta 批次器：push 进来的增量攒够一个间隔才 flush 一次；
 * dispose 前可 flushNow 兜底，保证末尾不丢。
 */
export class DeltaBatcher {
  private pending = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly emit: (text: string) => void,
    private readonly intervalMs: number = TOKEN_BATCH_MS,
  ) {}

  push(delta: string): void {
    if (this.disposed || delta === '') return;
    this.pending += delta;
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flushNow(), this.intervalMs);
    }
  }

  flushNow(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending !== '') {
      const text = this.pending;
      this.pending = '';
      this.emit(text);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.flushNow();
  }
}
