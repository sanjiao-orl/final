// 模块职责：POST /v1/review 的贵档冷读审阅管道——经 MCP 工具 ledger_slice 组装单章冷读提示词，
// 一次性调用 main 档模型，用 generateText + Output.array 结构化输出（SDK 按 responseFormat 约束模型
// 输出 { elements: [...] } 并解析 + zod 校验）返回 findings JSON（非 SSE）。
// 纪律：core 不额外注入任何文件内容，单章正文只由 domain ledger_slice 注入（防全稿注入红线）。
// 闭环：findings 非空时确定性经 MCP issue_append 追加进 issues.md（工具不可用/失败仅 warn 降级，不阻断返回）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  generateText,
  JSONParseError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  TypeValidationError,
  type LanguageModel,
  type ToolSet,
} from 'ai';
import { z } from 'zod';
import { getLlmTimeoutSeconds, type Tier } from './config.js';
import { HttpError, writeJson } from './http.js';
import { loadPersona, loadPrompt } from './prompts.js';

export const reviewBodySchema = z.object({
  workDir: z.string().min(1),
  chapterRelPath: z.string().min(1),
  /**
   * 姿态层角色名（决策 0010）：按名解析角色正文，拼系统提示「## 当前角色」段。
   * review 输出契约封存不动（role 只影响评判姿态）；无 persona 或按名找不到 = 零注入。
   */
  persona: z
    .string()
    .min(1)
    .max(100)
    .refine((s) => !/[\x00-\x1f\x7f]/.test(s), '不能包含控制字符')
    .optional(),
});
export type ReviewBody = z.infer<typeof reviewBodySchema>;

export interface ReviewDeps {
  modelForTier: (tier: Tier) => LanguageModel;
  /** MCP 领域工具注册表；ledger_slice 从这里取。 */
  tools: ToolSet | undefined;
  /** MCP 当前是否可用；缺省视为可用（与工具代理口径一致）。 */
  toolsAvailable?: () => boolean;
}

export const reviewFindingSchema = z.object({
  severity: z.enum(['BLOCKER', 'MAJOR', 'MODERATE', 'MINOR']),
  category: z.enum(['CONT', 'CANON', 'VOICE', 'CRAFT', 'STRUCT', 'PACE', 'REPEAT', 'META']).optional(),
  quote: z.string(),
  why: z.string(),
  suggestion: z.string().optional(),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

/**
 * 处理一次 /v1/review 请求。body 校验失败 400；ledger_slice 不可用 503；模型输出解析/校验失败 502；
 * 其余内部错误由路由层统一脱敏为 500。
 */
export async function handleReviewRequest(
  body: unknown,
  deps: ReviewDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const parsed = reviewBodySchema.safeParse(body);
  if (!parsed.success) {
    writeJson(res, 400, { error: '请求体不合法: ' + parsed.error.issues.map((i) => i.message).join('; ') }, req.headers.origin);
    return;
  }
  const { workDir, chapterRelPath } = parsed.data;

  // 断连中止：只挂 res.on('close')——请求体在进入本函数前已被路由层读完。
  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.on('close', onClose);

  // 服务端超时：provider 挂起时也强制中止，避免请求无限挂着（客户端断连信号仍优先）。
  const timeoutSeconds = getLlmTimeoutSeconds();
  const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);

  try {
    // 第一步：调 domain 工具组装冷读提示词（只含单章正文 + 账本切片）。
    const slice = await callLedgerSlice(deps, workDir, chapterRelPath, abort.signal);

    // 第二步：main 档模型一次性结构化输出。generateText + Output.array 由 SDK 按 responseFormat
    // 约束模型输出 { elements: [...] } 并解析 + zod 校验，result.output 即 ReviewFinding[]（无围栏容错）。
    // system 每次请求现取（mtime 感知热重载，改文件即生效）。
    let system = loadPrompt('review');
    // 姿态层：角色注入（决策 0010）——只影响评判姿态，输出契约（findings JSON）不动。
    if (parsed.data.persona) {
      const personaBody = loadPersona(parsed.data.persona, workDir);
      if (personaBody) {
        system += `\n\n## 当前角色\n${personaBody}`;
      }
    }
    const result = await generateText({
      model: deps.modelForTier('review'),
      system,
      prompt: slice,
      output: Output.array({ element: reviewFindingSchema }),
      abortSignal: AbortSignal.any([abort.signal, timeoutSignal]),
    });
    const findings = await result.output;

    // 闭环：findings 非空时确定性经 domain issue_append 追加进 issues.md；失败降级，不影响 findings 返回。
    const payload: { findings: ReviewFinding[]; persisted?: { appended: number; ids: string[] } } = { findings };
    if (findings.length > 0) {
      const persisted = await persistFindings(deps, workDir, chapterRelPath, findings);
      if (persisted) payload.persisted = persisted;
    }
    writeJson(res, 200, payload, req.headers.origin);
  } catch (err) {
    if (abort.signal.aborted) return;
    if (timeoutSignal.aborted) {
      throw new HttpError(504, `LLM 请求超时（超过 ${timeoutSeconds} 秒）`);
    }
    // SDK 结构化输出失败统一 502：Output.array 解析/校验失败抛 NoObjectGeneratedError
    // （cause 为 JSONParseError/TypeValidationError）；非 stop 结束导致无输出抛 NoOutputGeneratedError。
    if (
      NoObjectGeneratedError.isInstance(err) ||
      NoOutputGeneratedError.isInstance(err) ||
      JSONParseError.isInstance(err) ||
      TypeValidationError.isInstance(err)
    ) {
      throw new HttpError(502, '模型输出不是合法 JSON 审阅结果（需为 findings 数组）');
    }
    throw err;
  } finally {
    res.off('close', onClose);
  }
}

/** 调 ledger_slice 并取出 slice 文本。MCP 重连中 / 工具缺失都按 503（贵档依赖该工具）。 */
async function callLedgerSlice(
  deps: ReviewDeps,
  workDir: string,
  chapterRelPath: string,
  abortSignal: AbortSignal,
): Promise<string> {
  if (deps.toolsAvailable && !deps.toolsAvailable()) {
    throw new HttpError(503, 'ledger_slice 工具暂不可用（domain MCP 重连中，请稍后重试）');
  }
  const tool = deps.tools?.['ledger_slice'];
  if (!tool?.execute) {
    throw new HttpError(503, 'ledger_slice 工具不可用（domain MCP 未连接或工具不存在）');
  }
  const result: unknown = await tool.execute({ workDir, chapterRelPath } as never, {
    toolCallId: 'review-ledger-slice',
    messages: [],
    context: undefined,
    abortSignal,
  });
  return extractSlice(result);
}

/** 从 MCP 工具结果中提取 slice 文本：兼容 structuredContent / 直接返回对象 / content text JSON。 */
function extractSlice(result: unknown): string {
  if (!result || typeof result !== 'object') {
    throw new HttpError(502, 'ledger_slice 未返回有效切片');
  }
  const r = result as {
    isError?: unknown;
    structuredContent?: unknown;
    slice?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = r.content?.find((c) => c && c.type === 'text' && typeof c.text === 'string')?.text;
  if (r.isError) {
    throw new HttpError(502, `ledger_slice 执行失败：${text ?? '未知错误'}`);
  }

  const candidates: unknown[] = [];
  if (r.structuredContent !== undefined) candidates.push(r.structuredContent);
  if (typeof r.slice === 'string') candidates.push(r.slice);
  if (text !== undefined) {
    try {
      candidates.push(JSON.parse(text));
    } catch {
      candidates.push(text);
    }
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && typeof (candidate as { slice?: unknown }).slice === 'string') {
      return (candidate as { slice: string }).slice;
    }
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  throw new HttpError(502, 'ledger_slice 未返回有效切片');
}

/**
 * 经 domain issue_append 工具把 findings 确定性追加进 issues.md（不靠模型自觉）。
 * chapter 由 core 统一注入请求的章相对路径；issueLogPath 缺省走 domain 默认。
 * 工具不可用（无 MCP 连接）或调用失败时 console.warn 降级返回 undefined，不影响 findings 返回。
 */
async function persistFindings(
  deps: ReviewDeps,
  workDir: string,
  chapterRelPath: string,
  findings: ReviewFinding[],
): Promise<{ appended: number; ids: string[] } | undefined> {
  if (deps.toolsAvailable && !deps.toolsAvailable()) {
    console.warn('[review] issue_append 工具暂不可用（domain MCP 重连中），findings 未落盘');
    return undefined;
  }
  const tool = deps.tools?.['issue_append'];
  if (!tool?.execute) {
    console.warn('[review] issue_append 工具不可用（domain MCP 未连接或工具不存在），findings 未落盘');
    return undefined;
  }
  try {
    const result: unknown = await tool.execute(
      { workDir, findings: findings.map((f) => ({ ...f, chapter: chapterRelPath })) } as never,
      {
        toolCallId: 'review-issue-append',
        messages: [],
        context: undefined,
      },
    );
    return extractPersisted(result);
  } catch (err) {
    console.warn('[review] issue_append 落盘失败，findings 未落盘：', err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** 从 issue_append 工具结果中提取 { appended, ids }：兼容 structuredContent / 直接返回对象 / content text JSON；取不到返回 undefined（降级）。 */
function extractPersisted(result: unknown): { appended: number; ids: string[] } | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as {
    isError?: unknown;
    structuredContent?: unknown;
    appended?: unknown;
    ids?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (r.isError) {
    const text = r.content?.find((c) => c && c.type === 'text' && typeof c.text === 'string')?.text;
    console.warn(`[review] issue_append 执行失败，findings 未落盘：${text ?? '未知错误'}`);
    return undefined;
  }

  const candidates: unknown[] = [];
  if (r.structuredContent !== undefined) candidates.push(r.structuredContent);
  if (r.appended !== undefined || r.ids !== undefined) candidates.push(r);
  const text = r.content?.find((c) => c && c.type === 'text' && typeof c.text === 'string')?.text;
  if (text !== undefined) {
    try {
      candidates.push(JSON.parse(text));
    } catch {
      candidates.push(text);
    }
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const c = candidate as { appended?: unknown; ids?: unknown };
    if (typeof c.appended === 'number' && Array.isArray(c.ids) && c.ids.every((i) => typeof i === 'string')) {
      return { appended: c.appended, ids: c.ids as string[] };
    }
  }
  return undefined;
}
