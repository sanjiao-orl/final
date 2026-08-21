// 模块职责：本地 HTTP 服务——路由（协议版本化：全部业务路由在 /v1/ 前缀下，契约见 docs/decisions/0007）、
// Bearer 鉴权（/v1/health 豁免；/v1/dev 免鉴权但受 devEnabled 门禁——prod bundle 下关闭回 404）、CORS；业务委托给 chat 管道与 session-store。
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { asSchema, type FlexibleSchema } from 'ai';
import { z } from 'zod';
import { handleChatRequest, type ChatDeps } from './chat.js';
import { getGitCommit } from './config.js';
import { devPage } from './dev.js';
import { corsHeadersFor, HttpError, readJsonBody, toPublicErrorMessage, writeJson, writeJson413 } from './http.js';
import { handleReviewRequest } from './review.js';
import { handleContinueRequest, type ContinueDeps } from './continue.js';
import { handleRewriteRequest, type RewriteDeps } from './rewrite.js';
import { listPosture } from './prompts.js';
import { normalizeWorkDir } from './workdir.js';
import { PROTOCOL_VERSION } from './runtime.js';
import { CandidateStore, CandidateStateError, type CandidateStatus } from './candidate-store.js';
import type { SessionStore } from './session-store.js';

/** esbuild 构建时注入的 git 短 commit（scripts/build-sidecar.mjs 的 define）；tsx 开发运行时未定义则回退到实时 git。 */
declare const __CORE_COMMIT__: string | undefined;
const CORE_COMMIT = typeof __CORE_COMMIT__ !== 'undefined' ? __CORE_COMMIT__ : getGitCommit();

/** /v1/dev 联调页开关缺省：tsx 开发运行时（__CORE_COMMIT__ 未定义）为 true，esbuild prod bundle 注入后为 false。 */
function devEnabledDefault(): boolean {
  return typeof __CORE_COMMIT__ === 'undefined';
}

export interface ServerDeps {
  token: string;
  store: SessionStore;
  chat: ChatDeps;
  candidates: CandidateStore;
  rewrite: RewriteDeps;
  continue: ContinueDeps;
  version: string;
  /** /v1/dev 联调页开关：缺省 = tsx dev 运行时开、prod bundle 关（见 devEnabledDefault）。 */
  devEnabled?: boolean;
}

const candidateCreateSchema = z
  .object({
    chapter: z.string().min(1).max(500),
    // original 松开 min(1)：append/replace_all 允许为空（空串或缺省）；kind=replace（含缺省）时须非空，见下方 refine。
    original: z.string().max(20_000).optional(),
    proposed: z.string().min(1).max(20_000),
    instruction: z.string().max(2_000).optional(),
    sessionId: z.string().uuid().optional(),
    kind: z.enum(['replace', 'append', 'replace_all']).optional(),
  })
  .refine((o) => (o.kind ?? 'replace') !== 'replace' || (o.original !== undefined && o.original.length > 0), {
    message: 'kind=replace（含缺省）时 original 必须非空',
    path: ['original'],
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
      // 错误脱敏：HttpError 透传业务消息；其余内部错误只回稳定占位，原始细节已写 stderr。
      const message = toPublicErrorMessage(err);
      if (!res.headersSent) {
        if (status === 413) {
          // 请求体超限：残留 body 会污染 keep-alive 下一请求，必须关连接（见 writeJson413 注释）。
          writeJson413(req, res, req.headers.origin, { error: message });
        } else {
          writeJson(res, status, { error: message }, req.headers.origin);
        }
      } else {
        res.end();
      }
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  // CORS 预检（白名单口径与普通响应一致：白名单 Origin 反射，其余不给 Allow-Origin）
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeadersFor(req.headers.origin));
    res.end();
    return;
  }

  // 公开端点（免鉴权）
  if (req.method === 'GET' && pathname === '/v1/health') {
    writeJson(res, 200, { ok: true, version: deps.version, protocol: PROTOCOL_VERSION, commit: CORE_COMMIT }, req.headers.origin);
    return;
  }
  if (req.method === 'GET' && pathname === '/v1/dev') {
    // 门禁：prod bundle（devEnabled 缺省为 false）下联调页关闭，按其他 404 同形回；dev 下照常免鉴权开放。
    if ((deps.devEnabled ?? devEnabledDefault()) === false) {
      writeJson(res, 404, { error: `未找到: ${req.method} ${pathname}` }, req.headers.origin);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...corsHeadersFor(req.headers.origin) });
    res.end(devPage(deps.version));
    return;
  }

  // 协议已版本化：无 /v1/ 前缀的路径一律 404（在鉴权之前判定，旧客户端不带 token 也能看到迁移提示）
  if (!pathname.startsWith('/v1/')) {
    writeJson(res, 404, {
      error: `未找到: ${req.method} ${pathname}（协议已版本化：请使用 /v1/ 前缀，契约见 docs/decisions/0007）`,
    }, req.headers.origin);
    return;
  }

  // 其余端点一律校验 Authorization: Bearer
  if (req.headers.authorization !== `Bearer ${deps.token}`) {
    writeJson(res, 401, { error: '未授权：需要 Authorization: Bearer <token>' }, req.headers.origin);
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/sessions') {
    // ?scope= 精确过滤讨论归属：''=无归属，章 relPath=章节内；缺省返回全部。
    const scope = url.searchParams.get('scope');
    const sessions = deps.store.listSessions(scope ?? undefined);
    writeJson(res, 200, { sessions }, req.headers.origin);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/v1/sessions/')) {
    const id = pathname.slice('/v1/sessions/'.length);
    if (!id || !deps.store.getSession(id)) {
      writeJson(res, 404, { error: '会话不存在: ' + id }, req.headers.origin);
      return;
    }
    const messages = deps.store.listMessages(id);
    writeJson(res, 200, { sessionId: id, messages }, req.headers.origin);
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/posture') {
    // 姿态清单（决策 0010/0013）：app 级 + 可选书级（遮蔽只露书级）+ 激活方案名。
    // workDir 省略只回 app 级；传了则过存在性/目录校验（同 chat/rewrite 口径，非法 400）。
    const raw = url.searchParams.get('workDir');
    const workDir = raw ? normalizeWorkDir(raw) : undefined;
    writeJson(res, 200, listPosture(workDir), req.headers.origin);
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/v1/tools/')) {
    const name = decodePathSegment(pathname.slice('/v1/tools/'.length));
    if (!name || name.includes('/')) throw new HttpError(404, `工具名非法: ${name}`);
    // MCP 重连期间无论工具对象是否残留，一律 503；连接恢复后缺工具才回 404。
    if (deps.chat.toolsAvailable && !deps.chat.toolsAvailable()) {
      throw new HttpError(503, `工具暂不可用: ${name}（domain MCP 重连中，请稍后重试）`);
    }
    const tool = deps.chat.tools?.[name];
    if (!tool?.execute) {
      throw new HttpError(404, `工具不可用: ${name}（domain MCP 未连接或工具不存在）`);
    }
    const args = await readJsonBody(req);
    const validated = await validateToolInput(tool, args);
    if (!validated.ok) {
      throw new HttpError(400, '请求体不合法: ' + validated.error);
    }
    const result: unknown = await tool.execute(validated.value as never, {
      toolCallId: 'http-proxy',
      messages: [],
      context: undefined,
    });
    writeJson(res, 200, unwrapToolResult(result), req.headers.origin);
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/chat') {
    const body = await readJsonBody(req);
    await handleChatRequest(body, deps.chat, req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/review') {
    const body = await readJsonBody(req);
    await handleReviewRequest(body, {
      modelForTier: deps.chat.modelForTier,
      tools: deps.chat.tools,
      ...(deps.chat.toolsAvailable ? { toolsAvailable: deps.chat.toolsAvailable } : {}),
    }, req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/rewrite') {
    const body = await readJsonBody(req);
    await handleRewriteRequest(body, deps.rewrite, req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/continue') {
    const body = await readJsonBody(req);
    await handleContinueRequest(body, deps.continue, req, res);
    return;
  }

  if (pathname === '/v1/candidates' || pathname.startsWith('/v1/candidates/')) {
    await routeCandidates(req, res, url, deps.candidates);
    return;
  }

  writeJson(res, 404, { error: `未找到: ${req.method} ${pathname}` }, req.headers.origin);
}

type ToolInputValidation =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/** 解码 URL 路径段；非法百分号编码（decodeURIComponent 抛 URIError）按客户端入参错误回 400，而不是 500。 */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, '路径含非法 URL 编码');
  }
}

/** 把 zod/AI SDK 校验错误格式化成与 chat/rewrite 一致的 issues 文本。 */
function formatValidationIssues(error: unknown): string {
  const issues = (error as { issues?: Array<{ message?: string }> } | undefined)?.issues;
  return issues?.map((i) => i.message ?? '').join('; ') || '工具入参不合法';
}

/**
 * /v1/tools/:name 代理前的入参校验：本地 zod 工具走 safeParse；
 * MCP 工具的 JSON Schema 经 asSchema/z.fromJSONSchema 校验，不再把原始 body 直接塞给 execute。
 */
async function validateToolInput(
  tool: { inputSchema?: unknown },
  args: unknown
): Promise<ToolInputValidation> {
  const schema = tool.inputSchema;
  if (!schema) return { ok: true, value: args };

  // zod 3/4 都暴露 safeParse；本地领域工具经 ai tool() 注入时 inputSchema 即 ZodType。
  const zodLike = schema as {
    safeParse?: (value: unknown) => { success: boolean; data?: unknown; error?: unknown };
  };
  if (typeof zodLike.safeParse === 'function') {
    const parsed = zodLike.safeParse(args);
    if (parsed.success) return { ok: true, value: parsed.data ?? args };
    return { ok: false, error: formatValidationIssues(parsed.error) };
  }

  try {
    const aiSchema = asSchema(schema as FlexibleSchema<unknown>);
    if (aiSchema.validate) {
      const result = await aiSchema.validate(args);
      if (result.success) return { ok: true, value: result.value };
      return { ok: false, error: result.error.message };
    }
    const json = await aiSchema.jsonSchema;
    const parsed = z.fromJSONSchema(json).safeParse(args);
    if (parsed.success) return { ok: true, value: parsed.data ?? args };
    return { ok: false, error: formatValidationIssues(parsed.error) };
  } catch (err) {
    return { ok: false, error: `工具入参 schema 校验失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** /v1/candidates 路由：GET 列表（?status=&chapter=）、POST 新建、PATCH 状态/整改。 */
async function routeCandidates(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: CandidateStore
): Promise<void> {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/v1/candidates') {
    const status = url.searchParams.get('status');
    if (status !== null && !['pending', 'adopted', 'discarded'].includes(status)) {
      throw new HttpError(400, `status 取值非法: ${status}`);
    }
    const chapter = url.searchParams.get('chapter');
    const candidates = store.list({
      status: (status as CandidateStatus | null) ?? undefined,
      chapter: chapter ?? undefined,
    });
    writeJson(res, 200, { candidates }, req.headers.origin);
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/candidates') {
    const parsed = candidateCreateSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      throw new HttpError(400, '请求体不合法: ' + parsed.error.issues.map((i) => i.message).join('; '));
    }
    const candidate = store.create({ ...parsed.data, original: parsed.data.original ?? '' });
    writeJson(res, 200, { candidate }, req.headers.origin);
    return;
  }

  const patchMatch = /^\/v1\/candidates\/([^/]+)$/.exec(pathname);
  if (req.method === 'PATCH' && patchMatch) {
    const id = decodePathSegment(patchMatch[1]!);
    const parsed = candidatePatchSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      throw new HttpError(400, '请求体不合法: ' + parsed.error.issues.map((i) => i.message).join('; '));
    }
    let candidate;
    try {
      candidate = store.patch(id, parsed.data);
    } catch (err) {
      // 候选状态机非法迁移（如 adopted→discarded）是业务校验失败：映射 400 透传中文原因，区别于 404/500。
      if (err instanceof CandidateStateError) throw new HttpError(400, err.message);
      throw err;
    }
    if (!candidate) throw new HttpError(404, '候选不存在: ' + id);
    writeJson(res, 200, { candidate }, req.headers.origin);
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