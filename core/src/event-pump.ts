// 模块职责：SSE 事件唯一发射点（event_pump，D4）。所有对外 SSE 帧都经此写入——
// 帧按发射序排队串行写出，多个异步生产者并发 emit 也不会交错（无多路写入风险）；
// 泵可绑定会话，同一会话的事件顺序 = 发射顺序；done/error 后不再接受新帧。
import type { ServerResponse } from 'node:http';
import { startSse } from './http.js';

export class EventPump {
  /** 写队列尾：每条帧追加到链尾，保证写序 = 发射序。 */
  private tail: Promise<void> = Promise.resolve();
  /** 已 end（done/error 已排队）：此后 emit 一律丢弃，保证结束事件是最后一帧。 */
  private ended = false;

  constructor(
    private readonly res: ServerResponse,
    /** 绑定的会话 id（/chat 有；/rewrite 等无状态流为 undefined）。 */
    readonly sessionId?: string,
  ) {}

  /** 进入 SSE 响应（响应头 + 保活注释帧）。 */
  start(): void {
    startSse(this.res);
  }

  /** 发射一帧 SSE 事件。end 之后调用静默丢弃（结束帧之后不允许再有事件）。 */
  emit(event: string, data: unknown): void {
    if (this.ended || this.res.destroyed || this.res.writableEnded) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.tail = this.tail.then(() => {
      if (!this.res.destroyed && !this.res.writableEnded) this.res.write(frame);
    });
  }

  /** 结束流：排在已入队帧之后，保证 done/error 为流的最后一帧。 */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.tail = this.tail.then(() => {
      if (!this.res.destroyed && !this.res.writableEnded) this.res.end();
    });
  }

  /** 等待已入队帧全部写完（测试与关闭路径用）。 */
  flush(): Promise<void> {
    return this.tail;
  }
}
