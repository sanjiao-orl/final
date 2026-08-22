// 模块职责：core 侧同步调用 domain MCP 工具的小封装——执行 + 结果展开（structuredContent /
// 直接返回对象 / content text JSON 三态，review.ts extractSlice 同口径），供 summary /
// quality-check 这类非 SSE 管道复用。工具缺失/执行失败/结果 isError 一律抛 HttpError(502)，
// 由端点层直接透传中文 message。
import type { ToolSet } from 'ai';
import { HttpError } from './http.js';

interface DomainToolLike {
  description?: string;
  execute?: unknown;
}

/**
 * 调一个 domain 工具并返回原始 MCP 结果（未展开）。
 * 工具缺失（无连接/不存在）→ 502；执行异常 → 502 带原因；abortSignal 随调透传（客户端断连可中止）。
 */
export async function callDomainTool(
  tools: ToolSet | undefined,
  name: string,
  input: unknown,
  opts: { toolCallId: string; abortSignal?: AbortSignal }
): Promise<unknown> {
  const tool = tools?.[name] as DomainToolLike | undefined;
  if (!tool?.execute) {
    throw new HttpError(502, `${name} 工具不可用（domain MCP 未连接或工具不存在）`);
  }
  try {
    const run = tool.execute as (
      input: never,
      options: { toolCallId: string; messages: []; context: undefined; abortSignal?: AbortSignal }
    ) => Promise<unknown>;
    return await run(input as never, {
      toolCallId: opts.toolCallId,
      messages: [],
      context: undefined,
      // exactOptionalPropertyTypes：signal 缺省时不给键，而不是显式塞 undefined
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    });
  } catch (err) {
    throw new HttpError(502, `${name} 工具执行失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 展开 MCP 工具结果：isError → 502（带 text 内容）；否则按 structuredContent →
 * content text JSON 解析 → 原始结果对象 三态取第一个对象返回
 * （末态兜底本地工具直接返回对象的形态，review.ts extractSlice 同口径）；
 * 取不到返回 undefined（调用方自行报无效）。
 */
export function unwrapToolPayload(result: unknown): unknown {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as {
    isError?: unknown;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = Array.isArray(r.content)
    ? r.content.find((c) => c && c.type === 'text' && typeof c.text === 'string')?.text
    : undefined;
  if (r.isError) {
    throw new HttpError(502, `工具执行失败: ${text ?? JSON.stringify(result)}`);
  }
  const candidates: unknown[] = [];
  if (r.structuredContent !== undefined) candidates.push(r.structuredContent);
  if (text !== undefined) {
    try {
      candidates.push(JSON.parse(text));
    } catch {
      // 非 JSON 文本不进候选
    }
  }
  candidates.push(result);
  return candidates.find((c) => c !== null && typeof c === 'object');
}
