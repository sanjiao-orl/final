// 模块职责：POST /chat 的 SSE 聊天管道——落库用户消息 → streamText 多轮工具流 → 逐条转发 SSE → done 前落库完整 assistant 消息；客户端断连中止 LLM 请求。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stepCountIs, streamText, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import type { SessionRow, SessionStore } from './session-store.js';
import { sse, startSse, writeJson } from './http.js';

export const chatBodySchema = z.object({
  sessionId: z.string().uuid().optional(),
  text: z.string().min(1).max(20_000),
  tier: z.enum(['writing', 'background']).optional(),
});
export type ChatBody = z.infer<typeof chatBodySchema>;

export interface ChatDeps {
  store: SessionStore;
  /** 按档位返回模型；测试注入 mock。 */
  modelForTier: (tier: 'writing' | 'background') => LanguageModel;
  /** MCP 领域工具，连不上时为 undefined。 */
  tools: ToolSet | undefined;
}

const SYSTEM_PROMPT =
  '你是小说写作工作台的本地写作助手。回答精炼、贴合网文创作场景；' +
  '涉及作品结构、章节内容时优先调用提供的领域工具去读取真实文件，不要凭记忆编造正文。';

/** 多轮工具调用的步数上限。 */
const MAX_STEPS = 8;

/**
 * 处理一次 /chat 请求。校验、会话解析、用户消息落库在 SSE 之前完成（失败返回 JSON 错误）；
 * 之后进入 SSE 流，逐条转发 AI SDK 事件，done 前落库完整 assistant 消息。
 */
export async function handleChatRequest(
  body: unknown,
  deps: ChatDeps,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const parsed = chatBodySchema.safeParse(body);
  if (!parsed.success) {
    writeJson(res, 400, { error: '请求体不合法: ' + parsed.error.issues.map((i) => i.message).join('; ') });
    return;
  }
  const { text } = parsed.data;
  const tier = parsed.data.tier ?? 'writing';

  // 会话解析：缺省新建，title 取首条用户消息前 20 字。
  let session: SessionRow | undefined;
  if (parsed.data.sessionId) {
    session = deps.store.getSession(parsed.data.sessionId);
    if (!session) {
      writeJson(res, 404, { error: '会话不存在: ' + parsed.data.sessionId });
      return;
    }
  } else {
    session = deps.store.createSession(text.trim().slice(0, 20));
  }
  // 两个分支后 session 必非空
  const sessionId = session.id;

  // 用户消息先落库：即使客户端中途断连也不丢。
  deps.store.addMessage(sessionId, { role: 'user', content: text });

  const abort = new AbortController();
  const onClose = () => abort.abort();
  req.on('close', onClose);
  res.on('close', onClose);

  startSse(res);
  try {
    const model = deps.modelForTier(tier);
    const options: Parameters<typeof streamText>[0] = {
      model,
      system: SYSTEM_PROMPT,
      prompt: text,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: abort.signal,
    };
    if (deps.tools) options.tools = deps.tools;
    const result = streamText(options);

    let assistantText = '';
    const toolCalls: { id: string; name: string; args: unknown }[] = [];
    for await (const part of result.stream) {
      switch (part.type) {
        case 'text-delta':
          assistantText += part.text;
          sse(res, 'text-delta', { delta: part.text });
          break;
        case 'tool-call': {
          const call = { id: part.toolCallId, name: part.toolName, args: part.input ?? {} };
          toolCalls.push(call);
          sse(res, 'tool-call', call);
          break;
        }
        case 'tool-result':
          sse(res, 'tool-result', { id: part.toolCallId, name: part.toolName, result: part.output ?? null });
          break;
        case 'error':
          throw new Error(part.error instanceof Error ? part.error.message : String(part.error));
        default:
          // start-step / finish-step / finish 等元事件不转发
          break;
      }
    }

    if (abort.signal.aborted) {
      // 客户端断连：不落库、不发 done。
      res.end();
      return;
    }

    // done 前把完整 assistant 消息落库。
    const assistantMsg = deps.store.addMessage(sessionId, {
      role: 'assistant',
      content: assistantText,
      toolCalls,
    });
    sse(res, 'done', { sessionId, messageId: assistantMsg.id });
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
