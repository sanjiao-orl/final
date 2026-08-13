// 模块职责：POST /v1/review 的贵档冷读审阅管道——经 MCP 工具 ledger_slice 组装单章冷读提示词，
// 一次性调用 main 档模型，要求严格输出 findings JSON 数组；解析 + zod 校验后返回 JSON（非 SSE）。
// 纪律：core 不额外注入任何文件内容，单章正文只由 domain ledger_slice 注入（防全稿注入红线）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { streamText, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import { getLlmTimeoutSeconds } from './config.js';
import { HttpError, writeJson } from './http.js';

export const reviewBodySchema = z.object({
  workDir: z.string().min(1),
  chapterRelPath: z.string().min(1),
});
export type ReviewBody = z.infer<typeof reviewBodySchema>;

export interface ReviewDeps {
  modelForTier: (tier: 'writing' | 'background') => LanguageModel;
  /** MCP 领域工具注册表；ledger_slice 从这里取。 */
  tools: ToolSet | undefined;
  /** MCP 当前是否可用；缺省视为可用（与工具代理口径一致）。 */
  toolsAvailable?: () => boolean;
}

export const reviewFindingSchema = z.object({
  severity: z.enum(['BLOCKER', 'MAJOR', 'MODERATE']),
  quote: z.string(),
  why: z.string(),
  suggestion: z.string().optional(),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

const reviewFindingsSchema = z.array(reviewFindingSchema);

const SYSTEM_PROMPT =
  '你是小说冷读审阅员。输入是「读者契约 + 四维账本切片 + 单章正文 + 问题日志尾部」。' +
  '严格按输入里的读者契约审阅该章：只依据输入内容判断，不臆造、不读取其他章节。' +
  '输出必须是严格 JSON：一个数组，每项为 ' +
  '{ severity: "BLOCKER"|"MAJOR"|"MODERATE", quote: string, why: string, suggestion?: string }。' +
  'severity 只能取 BLOCKER/MAJOR/MODERATE；quote 必须是该章正文里的原文短引；why 说明问题；suggestion 可选给修改建议。' +
  '只输出 JSON 数组本身：不要 Markdown 代码块、不要解释、不要任何前后缀。没有发现时输出 []。';

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
    writeJson(res, 400, { error: '请求体不合法: ' + parsed.error.issues.map((i) => i.message).join('; ') });
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

    // 第二步：main 档模型一次性调用。用 streamText 收全量文本后统一解析（非 SSE）。
    const result = streamText({
      model: deps.modelForTier('writing'),
      system: SYSTEM_PROMPT,
      prompt: slice,
      abortSignal: AbortSignal.any([abort.signal, timeoutSignal]),
    });

    let text = '';
    for await (const part of result.stream) {
      if (part.type === 'text-delta') {
        text += part.text;
      } else if (part.type === 'error') {
        throw new Error(part.error instanceof Error ? part.error.message : String(part.error));
      }
    }

    if (abort.signal.aborted) return;
    if (timeoutSignal.aborted) {
      throw new HttpError(504, `LLM 请求超时（超过 ${timeoutSeconds} 秒）`);
    }

    const findings = parseFindings(text);
    writeJson(res, 200, { findings });
  } catch (err) {
    if (abort.signal.aborted) return;
    if (timeoutSignal.aborted) {
      throw new HttpError(504, `LLM 请求超时（超过 ${timeoutSeconds} 秒）`);
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

/** 解析模型输出：容忍 ```json 围栏与前后废话，提取首个 JSON 数组，再用 zod 校验。 */
export function parseFindings(text: string): ReviewFinding[] {
  const parsed = reviewFindingsSchema.safeParse(extractFirstJsonArray(text));
  if (!parsed.success) {
    throw new HttpError(502, '模型输出不是合法 JSON 审阅结果（需为 findings 数组）');
  }
  return parsed.data;
}

/** 从模型输出文本中提取首个 JSON 数组；无数组/未闭合/解析失败一律抛 502。 */
function extractFirstJsonArray(text: string): unknown {
  const trimmed = text.trim();
  // 先剥掉第一个 ```json / ``` 围栏（有前后废话也能取到围栏内容）。
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1]! : trimmed;

  const start = candidate.indexOf('[');
  if (start < 0) {
    throw new HttpError(502, '模型输出未找到 JSON 数组');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          throw new HttpError(502, '模型输出 JSON 数组解析失败');
        }
      }
    }
  }
  throw new HttpError(502, '模型输出 JSON 数组未闭合');
}
