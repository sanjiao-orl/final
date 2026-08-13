// 模块职责：POST /v1/rewrite 的 SSE 改写管道——纯文本改写（无工具、不落库），
// 原文+指令进模型，改写结果流式吐回；产出由壳另行 POST /v1/candidates 进暂存区（人的方向 AI 的笔）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { streamText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { getLlmTimeoutSeconds } from './config.js';
import { EventPump } from './event-pump.js';
import { writeJson } from './http.js';

export const rewriteBodySchema = z.object({
  /** 选区原文（锚定文本，改写对象）。 */
  original: z.string().min(1).max(20_000),
  /** 改写指令；空串 = 只做文字润色。 */
  instruction: z.string().max(2_000).default(''),
});
export type RewriteBody = z.infer<typeof rewriteBodySchema>;

export interface RewriteDeps {
  modelForTier: (tier: 'writing' | 'background') => LanguageModel;
}

const SYSTEM_PROMPT =
  '你是小说改写器。输入是一段小说正文和一条改写指令。' +
  '只输出改写后的正文本身：不要解释、不要前后缀、不要引号、不要标题、不要任何标记；' +
  '保持网文连载的叙事文体与原文人称、视角、事实不变；原文是多段的，输出保持同样的段落数与换行；' +
  '指令为空时只做文字润色（疏通语句、增强画面感），不改变情节与细节。';

/** 改写输出护栏：绝对长度上限（字符）。 */
const MAX_OUTPUT_CHARS = 20_000;
/** 改写输出护栏：结果/原文长度比的下限与上限（低于下限疑似未完成，高于上限疑似注水）。 */
const OUTPUT_RATIO_MIN = 0.2;
const OUTPUT_RATIO_MAX = 3;

/** 处理一次 /v1/rewrite 请求。校验失败返回 JSON 错误；之后进入 SSE 流（text-delta / done / error，经 event_pump 单一发射点）。 */
export async function handleRewriteRequest(
  body: unknown,
  deps: RewriteDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const parsed = rewriteBodySchema.safeParse(body);
  if (!parsed.success) {
    writeJson(res, 400, { error: '请求体不合法: ' + parsed.error.issues.map((i) => i.message).join('; ') });
    return;
  }
  const { original, instruction } = parsed.data;

  const abort = new AbortController();
  const onClose = () => abort.abort();
  req.on('close', onClose);
  res.on('close', onClose);

  // 服务端超时：provider 挂起时也强制中止，避免请求无限挂着（客户端断连信号仍优先）。
  const timeoutSeconds = getLlmTimeoutSeconds();
  const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);

  const pump = new EventPump(res);
  pump.start();
  try {
    const result = streamText({
      model: deps.modelForTier('writing'),
      system: SYSTEM_PROMPT,
      prompt: `【原文】\n${original}\n\n【改写指令】\n${instruction || '（无）'}`,
      abortSignal: AbortSignal.any([abort.signal, timeoutSignal]),
    });

    let text = '';
    for await (const part of result.stream) {
      if (part.type === 'text-delta') {
        text += part.text;
        pump.emit('text-delta', { delta: part.text });
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
    if (!finalText) {
      pump.emit('error', { message: '模型返回了空改写结果' });
      pump.end();
      return;
    }
    // 输出护栏：改写结果异常（超长/过短/注水）不进暂存区，显式 error 让壳走失败红条。
    const guard = guardRewrite(finalText, original);
    if (guard) {
      pump.emit('error', { message: guard });
      pump.end();
      return;
    }
    pump.emit('done', { text: finalText });
    pump.end();
  } catch (err) {
    if (abort.signal.aborted) {
      pump.end();
      return;
    }
    if (timeoutSignal.aborted) {
      pump.emit('error', { message: `LLM 请求超时（超过 ${timeoutSeconds} 秒）` });
      pump.end();
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    pump.emit('error', { message });
    pump.end();
  } finally {
    req.off('close', onClose);
    res.off('close', onClose);
  }
}

/** 改写结果护栏：通过返回 null，违规返回给人看的错误消息。 */
export function guardRewrite(result: string, original: string): string | null {
  if (result.length > MAX_OUTPUT_CHARS) {
    return `改写结果超长（${result.length} 字符，上限 ${MAX_OUTPUT_CHARS}），已拒绝`;
  }
  const ratio = result.length / Math.max(original.trim().length, 1);
  if (ratio < OUTPUT_RATIO_MIN) {
    return `改写结果过短（${result.length} 字符 vs 原文 ${original.trim().length}，不足 20%），疑似未完成改写，已拒绝`;
  }
  if (ratio > OUTPUT_RATIO_MAX) {
    return `改写结果过长（${result.length} 字符 vs 原文 ${original.trim().length}，超过 3 倍），疑似注水，已拒绝`;
  }
  return null;
}
