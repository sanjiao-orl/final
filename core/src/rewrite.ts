// 模块职责：POST /v1/rewrite 的 SSE 改写管道——纯文本改写（无工具、不落库），
// 原文+指令进模型，改写结果流式吐回；产出由壳另行 POST /v1/candidates 进暂存区（人的方向 AI 的笔）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { streamText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { getLlmTimeoutSeconds } from './config.js';
import { EventPump } from './event-pump.js';
import { toPublicErrorMessage, writeJson } from './http.js';
import { loadPrompt } from './prompts.js';

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

  // 断连中止：只挂 res.on('close')——请求体在进入本函数前已被路由层读完，
  // 此刻再注册 req.on('close') 已无意义（request 侧事件早已完成），只会误导排查。
  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.on('close', onClose);

  // 服务端超时：provider 挂起时也强制中止，避免请求无限挂着（客户端断连信号仍优先）。
  const timeoutSeconds = getLlmTimeoutSeconds();
  const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);

  const pump = new EventPump(res);
  pump.start();
  try {
    const result = streamText({
      model: deps.modelForTier('writing'),
      system: loadPrompt('rewrite'), // 每次请求现取（mtime 感知热重载，改文件即生效）
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
    // 错误脱敏：非业务错误（provider 内部异常等）只回稳定占位，原始细节已写 stderr。
    pump.emit('error', { message: toPublicErrorMessage(err) });
    pump.end();
  } finally {
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
