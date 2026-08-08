// 模块职责：本地 HTTP 服务——路由、Bearer 鉴权（/health、/dev 豁免）、CORS；业务委托给 chat 管道与 session-store。
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleChatRequest, type ChatDeps } from './chat.js';
import { devPage } from './dev.js';
import { CORS_HEADERS, HttpError, readJsonBody, writeJson } from './http.js';
import type { SessionStore } from './session-store.js';

export interface ServerDeps {
  token: string;
  store: SessionStore;
  chat: ChatDeps;
  version: string;
}

export function createAppServer(deps: ServerDeps): Server {
  return createHttpServer((req, res) => {
    void route(req, res, deps).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) writeJson(res, status, { error: message });
      else res.end();
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // 公开端点（免鉴权）
  if (req.method === 'GET' && pathname === '/health') {
    writeJson(res, 200, { ok: true, version: deps.version });
    return;
  }
  if (req.method === 'GET' && pathname === '/dev') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
    res.end(devPage(deps.token));
    return;
  }

  // 其余端点一律校验 Authorization: Bearer
  if (req.headers.authorization !== `Bearer ${deps.token}`) {
    writeJson(res, 401, { error: '未授权：需要 Authorization: Bearer <token>' });
    return;
  }

  if (req.method === 'GET' && pathname === '/sessions') {
    const sessions = deps.store.listSessions();
    writeJson(res, 200, { sessions });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/sessions/')) {
    const id = pathname.slice('/sessions/'.length);
    if (!id || !deps.store.getSession(id)) {
      writeJson(res, 404, { error: '会话不存在: ' + id });
      return;
    }
    const messages = deps.store.listMessages(id);
    writeJson(res, 200, { sessionId: id, messages });
    return;
  }

  if (req.method === 'POST' && pathname === '/chat') {
    const body = await readJsonBody(req);
    await handleChatRequest(body, deps.chat, req, res);
    return;
  }

  writeJson(res, 404, { error: `未找到: ${req.method} ${pathname}` });
}
