// 模块职责：HTTP 层小工具——JSON 响应、SSE 帧、请求体读取、带状态码的业务错误、CORS 头。
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 本地联调用，CORS 全放开。 */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/** 带 HTTP 状态码的业务错误，路由层统一转成 JSON 响应。 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function writeJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
  res.end(JSON.stringify(data));
}

/** 进入 SSE 响应头；先写一行注释帧，避免代理/浏览器缓冲。
 * 注意：SSE 帧的写入一律走 event_pump（src/event-pump.ts，D4 单一发射点），
 * 各 handler 不得直接 res.write 帧。 */

export function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...CORS_HEADERS,
  });
  res.write(':ok\n\n');
}

/** 读取请求体 JSON，超限 413、非法 JSON 400（以 HttpError 拒绝）。 */
export function readJsonBody(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}