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
  ) {
    // 连接级 error 有监听即可避免进程崩溃；具体写失败由 writeFrame 的 Promise 捕获兜底。
    this.res.on('error', () => {});
  }

  /** 进入 SSE 响应（响应头 + 保活注释帧）。 */
  start(): void {
    startSse(this.res);
  }

  /** 发射一帧 SSE 事件。end 之后调用静默丢弃（结束帧之后不允许再有事件）。 */
  emit(event: string, data: unknown): void {
    if (this.ended || this.res.destroyed || this.res.writableEnded) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.enqueue(() => this.writeFrame(frame));
  }

  /** 结束流：排在已入队帧之后，保证 done/error 为流的最后一帧。 */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.enqueue(() => {
      if (!this.res.destroyed && !this.res.writableEnded) this.res.end();
    });
  }

  /** 等待已入队帧全部写完（测试与关闭路径用）。 */
  flush(): Promise<void> {
    return this.tail;
  }

  /** 把一步写入排到队尾；任一步失败只丢弃该步，后续帧/end 仍继续，避免流挂起。 */
  private enqueue(task: () => void | Promise<void>): void {
    this.tail = this.tail.then(task).catch(() => undefined);
  }

  /** 尊重 res.write 返回值：false 表示背压，等 drain 后再写下一帧；写失败 reject 交 enqueue 兜底。 */
  private writeFrame(frame: string): Promise<void> {
    if (this.res.destroyed || this.res.writableEnded) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        this.res.off('error', onError);
        this.res.off('close', onClose);
        this.res.off('drain', onDrain);
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error('SSE 连接已关闭'));
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      this.res.once('error', onError);
      this.res.once('close', onClose);
      try {
        const accepted = this.res.write(frame);
        if (accepted) {
          cleanup();
          resolve();
        } else {
          this.res.once('drain', onDrain);
        }
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}
