// 模块职责：HTTP 层小工具——JSON 响应、SSE 帧、请求体读取、带状态码的业务错误、CORS 头。
import type { IncomingMessage, ServerResponse } from 'node:http';

/** CORS 白名单（精确匹配）：Tauri WebView（Windows WebView2）的 Origin。 */
const CORS_ORIGIN_WHITELIST: ReadonlySet<string> = new Set([
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
]);

/**
 * 按请求 Origin 反射 CORS 头（白名单收窄，docs/decisions/0009 批三-1）：
 * - Origin 为 http://localhost 或 http://127.0.0.1 任意端口（hostname 判定，防 http://localhost.evil.com 前缀欺骗），
 *   或精确等于 CORS_ORIGIN_WHITELIST 内 Tauri Origin → 反射该 Origin 并加 Vary: Origin；
 * - Origin 不在白名单 → 不给 Access-Control-Allow-Origin（浏览器同源策略拦截；curl 等无 Origin 客户端不受影响）；
 * - 无 Origin → 不给 Allow-Origin 头，响应照常。
 * 其余头（Allow-Methods/Headers 等）固定随函数返回。
 */
export function corsHeadersFor(origin: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (!origin || !isAllowedCorsOrigin(origin)) return headers;
  headers['Access-Control-Allow-Origin'] = origin;
  headers['Vary'] = 'Origin';
  return headers;
}

function isAllowedCorsOrigin(origin: string): boolean {
  if (CORS_ORIGIN_WHITELIST.has(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** 带 HTTP 状态码的业务错误，路由层统一转成 JSON 响应。 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** 内部错误兜底消息：对客户端只给稳定占位，不泄露内部细节（路径/栈等）。 */
export const INTERNAL_ERROR_MESSAGE = '内部错误，详见 core 日志';

/**
 * 对外错误消息映射：HttpError（业务错误）透传自带 message；
 * 其余一律视为内部错误——响应体用稳定占位，原始细节（message/stack）写 stderr 供排查。
 */
export function toPublicErrorMessage(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[core] 内部错误: ${detail}`);
  return INTERNAL_ERROR_MESSAGE;
}

export function writeJson(res: ServerResponse, status: number, data: unknown, origin: string | undefined): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeadersFor(origin) });
  res.end(JSON.stringify(data));
}

/**
 * 413 响应（请求体超限，P3）：请求体未读完就 reject，keep-alive 连接上残留的 body 字节会被下一请求当请求行/头解析 → 错位。
 * 故 413 必须带 `Connection: close`，并在响应写完（res.end 回调）后销毁 socket 收尾连接，杜绝脏读。
 */
export function writeJson413(req: IncomingMessage, res: ServerResponse, origin: string | undefined, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(413, {
    'Content-Type': 'application/json; charset=utf-8',
    Connection: 'close',
    ...corsHeadersFor(origin),
  });
  res.end(JSON.stringify(data), () => req.destroy());
}

/** 进入 SSE 响应头；先写一行注释帧，避免代理/浏览器缓冲。
 * 注意：SSE 帧的写入一律走 event_pump（src/event-pump.ts，D4 单一发射点），
 * 各 handler 不得直接 res.write 帧。 */

export function startSse(res: ServerResponse, origin: string | undefined): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeadersFor(origin),
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
        // 只拒绝读取器：让路由能正常写出 413 JSON；此处不 destroy socket，否则响应发不出去。
        reject(new HttpError(413, '请求体过大'));
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