// 模块职责：本地 HTTP 服务——路由、Bearer 鉴权（/health、/dev 豁免）、CORS；业务委托给 chat 管道与 session-store。
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { handleChatRequest, type ChatDeps } from './chat.js';
import { devPage } from './dev.js';
import { CORS_HEADERS, HttpError, readJsonBody, writeJson } from './http.js';
import { handleRewriteRequest, type RewriteDeps } from './rewrite.js';
import type { CandidateStore, CandidateStatus } from './candidate-store.js';
import type { SessionStore } from './session-store.js';

export interface ServerDeps {
  token: string;
  store: SessionStore;
  chat: ChatDeps;
  candidates: CandidateStore;
  rewrite: RewriteDeps;
  version: string;
}

const candidateCreateSchema = z.object({
  chapter: z.string().min(1).max(500),
  original: z.string().min(1).max(20_000),
  proposed: z.string().min(1).max(20_000),
  instruction: z.string().max(2_000).optional(),
  sessionId: z.string().uuid().optional(),
});

const candidatePatchSchema = z
  .object({
    status: z.enum(['pending', 'adopted', 'discarded']).optional(),
    proposed: z.string().min(1).max(20_000).optional(),
    instruction: z.string().max(2_000).optional(),
  })
  .refine((o) => o.status !== undefined || o.proposed !== undefined || o.instruction !== undefined, {
    message: '至少要有一个待更新字段',
  });

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
    // ?scope= 精确过滤讨论归属：''=无归属，章 relPath=章节内；缺省返回全部。
    const scope = url.searchParams.get('scope');
    const sessions = deps.store.listSessions(scope ?? undefined);
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

  if (req.method === 'POST' && pathname.startsWith('/tools/')) {
    const name = decodeURIComponent(pathname.slice('/tools/'.length));
    if (!name || name.includes('/')) throw new HttpError(404, `工具名非法: ${name}`);
    const tool = deps.chat.tools?.[name];
    if (!tool?.execute) {
      throw new HttpError(404, `工具不可用: ${name}（domain MCP 未连接或工具不存在）`);
    }
    const args = await readJsonBody(req);
    const result: unknown = await tool.execute(args as never, {
      toolCallId: 'http-proxy',
      messages: [],
      context: undefined,
    });
    writeJson(res, 200, unwrapToolResult(result));
    return;
  }

  if (req.method === 'POST' && pathname === '/chat') {
    const body = await readJsonBody(req);
    await handleChatRequest(body, deps.chat, req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/rewrite') {
    const body = await readJsonBody(req);
    await handleRewriteRequest(body, deps.rewrite, req, res);
    return;
  }

  if (pathname === '/candidates' || pathname.startsWith('/candidates/')) {
    await routeCandidates(req, res, url, deps.candidates);
    return;
  }

  writeJson(res, 404, { error: `未找到: ${req.method} ${pathname}` });
}

/** /candidates 路由：GET 列表（?status=&chapter=）、POST 新建、PATCH 状态/整改。 */
async function routeCandidates(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: CandidateStore
): Promise<void> {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/candidates') {
    const status = url.searchParams.get('status');
    if (status !== null && !['pending', 'adopted', 'discarded'].includes(status)) {
      throw new HttpError(400, `status 取值非法: ${status}`);
    }
    const chapter = url.searchParams.get('chapter');
    const candidates = store.list({
      status: (status as CandidateStatus | null) ?? undefined,
      chapter: chapter ?? undefined,
    });
    writeJson(res, 200, { candidates });
    return;
  }

  if (req.method === 'POST' && pathname === '/candidates') {
    const parsed = candidateCreateSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      throw new HttpError(400, '请求体不合法: ' + parsed.error.issues.map((i) => i.message).join('; '));
    }
    const candidate = store.create(parsed.data);
    writeJson(res, 200, { candidate });
    return;
  }

  const patchMatch = /^\/candidates\/([^/]+)$/.exec(pathname);
  if (req.method === 'PATCH' && patchMatch) {
    const id = decodeURIComponent(patchMatch[1]!);
    const parsed = candidatePatchSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      throw new HttpError(400, '请求体不合法: ' + parsed.error.issues.map((i) => i.message).join('; '));
    }
    const candidate = store.patch(id, parsed.data);
    if (!candidate) throw new HttpError(404, '候选不存在: ' + id);
    writeJson(res, 200, { candidate });
    return;
  }

  throw new HttpError(404, `未找到: ${req.method} ${pathname}`);
}

/**
 * 展开 MCP 工具结果：isError → 502；structuredContent 优先；
 * 否则取首个 text 内容项，JSON 文本解析回对象，非 JSON 原样返回。
 */
function unwrapToolResult(result: unknown): unknown {
  if (result && typeof result === 'object') {
    const r = result as {
      isError?: unknown;
      structuredContent?: unknown;
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = r.content?.find((c) => c && c.type === 'text' && typeof c.text === 'string')?.text;
    if (r.isError) throw new HttpError(502, `工具执行失败: ${text ?? JSON.stringify(result)}`);
    if (r.structuredContent !== undefined) return r.structuredContent;
    if (text !== undefined) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return result;
}