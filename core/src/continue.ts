// 模块职责：POST /v1/continue 的 SSE 续写管道——纯文本续接（无工具、不落库），
// 正文尾巴+指令进 background 模型，续写结果流式吐回；产出由壳另行处理（人的方向 AI 的笔）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { streamText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { getLlmTimeoutSeconds } from './config.js';
import { EventPump } from './event-pump.js';
import { HttpError, toPublicErrorMessage, writeJson } from './http.js';
import { loadPrompt, loadStyleSummary } from './prompts.js';
import { normalizeWorkDir } from './workdir.js';

/** 续写请求正文上限：壳通常只送约 3000 字，8000 为防止上下文挤占输出预算的硬护栏。 */
const MAX_CONTEXT_CHARS = 8_000;
/** 续写输出上限：一次只生成适度篇幅，避免便宜档失控注水。 */
const MAX_OUTPUT_TOKENS = 1_200;

export const continueBodySchema = z.object({
  context: z.string().min(1),
  instruction: z.string().max(2_000).optional(),
  workDir: z
    .string()
    .min(1)
    .max(500)
    .refine((s) => !/[\x00-\x1f\x7f]/.test(s), '不能包含控制字符')
    .optional(),
});
export type ContinueBody = z.infer<typeof continueBodySchema>;

export interface ContinueDeps {
  modelForTier: (tier: 'background') => LanguageModel;
}

export async function handleContinueRequest(
  body: unknown,
  deps: ContinueDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const parsed = continueBodySchema.safeParse(body);
  if (!parsed.success) {
    writeJson(res, 400, { error: '请求体不合法: ' + parsed.error.issues.map((i) => i.message).join('; ') }, req.headers.origin);
    return;
  }
  const { context, instruction } = parsed.data;
  if (context.length > MAX_CONTEXT_CHARS) {
    throw new HttpError(413, `续写上下文超长（${context.length} 字符，上限 ${MAX_CONTEXT_CHARS}）`);
  }
  const workDir = parsed.data.workDir ? normalizeWorkDir(parsed.data.workDir) : undefined;
  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.on('close', onClose);
  const timeoutSeconds = getLlmTimeoutSeconds();
  const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
  const pump = new EventPump(res, undefined, req.headers.origin);
  pump.start();
  try {
    let system = loadPrompt('continue');
    if (workDir) {
      const summary = loadStyleSummary(workDir);
      if (summary) system += `\n\n## 声口摘要\n${summary}`;
    }
    const result = streamText({
      model: deps.modelForTier('background'),
      system,
      prompt: `【正文尾巴】\n${context}\n\n【续写指引】\n${instruction || '（无）'}`,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.any([abort.signal, timeoutSignal]),
    });
    let text = '';
    for await (const part of result.stream) {
      if (part.type === 'text-delta') {
        text += part.text;
        pump.emit('text-delta', { text: part.text });
      } else if (part.type === 'error') {
        throw new Error(part.error instanceof Error ? part.error.message : String(part.error));
      }
    }
    if (abort.signal.aborted) {
      pump.end();
      return;
    }
    if (timeoutSignal.aborted) {
      pump.emit('error', { message: `LLM 请求超时（超过 ${timeoutSeconds} 秒）` });
      pump.end();
      return;
    }
    const finalText = text.trim();
    if (!finalText) pump.emit('error', { message: '模型返回了空续写结果' });
    else pump.emit('done', { text: finalText });
    pump.end();
  } catch (err) {
    if (abort.signal.aborted) pump.end();
    else if (timeoutSignal.aborted) {
      pump.emit('error', { message: `LLM 请求超时（超过 ${timeoutSeconds} 秒）` });
      pump.end();
    } else {
      pump.emit('error', { message: toPublicErrorMessage(err) });
      pump.end();
    }
  } finally {
    res.off('close', onClose);
  }
}

export { MAX_CONTEXT_CHARS };
export const CONTINUE_MAX_OUTPUT_TOKENS = MAX_OUTPUT_TOKENS;
