// 模块职责：POST /rewrite 的 SSE 改写管道——纯文本改写（无工具、不落库），
// 原文+指令进模型，改写结果流式吐回；产出由壳另行 POST /candidates 进暂存区（人的方向 AI 的笔）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { streamText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { sse, startSse, writeJson } from './http.js';

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

/** 处理一次 /rewrite 请求。校验失败返回 JSON 错误；之后进入 SSE 流（text-delta / done / error）。 */
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

  startSse(res);
  try {
    const result = streamText({
      model: deps.modelForTier('writing'),
      system: SYSTEM_PROMPT,
      prompt: `【原文】\n${original}\n\n【改写指令】\n${instruction || '（无）'}`,
      abortSignal: abort.signal,
    });

    let text = '';
    for await (const part of result.stream) {
      if (part.type === 'text-delta') {
        text += part.text;
        sse(res, 'text-delta', { delta: part.text });
      } else if (part.type === 'error') {
        throw new Error(part.error instanceof Error ? part.error.message : String(part.error));
      }
    }

    if (abort.signal.aborted) {
      res.end();
      return;
    }
    const finalText = text.trim();
    if (!finalText) {
      sse(res, 'error', { message: '模型返回了空改写结果' });
      res.end();
      return;
    }
    sse(res, 'done', { text: finalText });
    res.end();
  } catch (err) {
    if (abort.signal.aborted) {
      res.end();
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    sse(res, 'error', { message });
    res.end();
  } finally {
    req.off('close', onClose);
    res.off('close', onClose);
  }
}
