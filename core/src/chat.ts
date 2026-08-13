// 模块职责：POST /v1/chat 的 SSE 聊天管道——落库用户消息 → streamText 多轮工具流 → 逐条转发 SSE → done 前落库完整 assistant 消息；客户端断连中止 LLM 请求。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stepCountIs, streamText, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import type { MessageRow, SessionRow, SessionStore } from './session-store.js';
import { getLlmTimeoutSeconds } from './config.js';
import { EventPump } from './event-pump.js';
import { writeJson } from './http.js';

export const chatBodySchema = z.object({
  sessionId: z.string().uuid().optional(),
  text: z.string().min(1).max(20_000),
  tier: z.enum(['writing', 'background']).optional(),
  /** 壳当前打开的作品文件夹绝对路径：拼进系统提示，让模型调工具时直接用。 */
  workDir: z.string().min(1).optional(),
  /** 新建会话的讨论归属：'' = 无归属；章 relPath = 章节内讨论。已存在的会话忽略此字段。 */
  scope: z.string().max(500).optional(),
});
export type ChatBody = z.infer<typeof chatBodySchema>;

export interface ChatDeps {
  store: SessionStore;
  /** 按档位返回模型；测试注入 mock。 */
  modelForTier: (tier: 'writing' | 'background') => LanguageModel;
  /** MCP 领域工具，连不上时为 undefined。 */
  tools: ToolSet | undefined;
  /** MCP 当前是否可用；缺省视为可用（保持无 MCP 注入时的旧行为）。 */
  toolsAvailable?: () => boolean;
}

const SYSTEM_PROMPT =
  '你是小说写作工作台的本地写作助手。回答精炼、贴合网文创作场景；' +
  '涉及作品结构、章节内容时优先调用提供的领域工具去读取真实文件，不要凭记忆编造正文。';

/** 壳传入当前作品文件夹时，拼进系统提示：调领域工具一律用这个 workDir。 */
function systemPrompt(workDir: string | undefined): string {
  if (!workDir) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}\n当前打开的作品文件夹：${workDir}。调用领域工具时 workDir 参数一律使用这个路径。`;
}

/** 多轮工具调用的步数上限。 */
const MAX_STEPS = 8;

/** 跨对话记忆：回放给模型的历史消息条数上限（含当前用户消息）。 */
const MAX_REPLAY_MESSAGES = 20;

/** 跨对话记忆：回放历史的总字符预算，超限从最旧处截断。 */
const MAX_REPLAY_CHARS = 25_000;

/**
 * 跨对话记忆：把会话历史回放成 messages（替代单轮 prompt: text）。
 * 已知限制：assistant 的工具调用结果不重放——AI SDK 要求 tool-call 与 tool-result 成对，
 * 而历史只存了 assistant 侧的 toolCalls，回放会校验失败；纯工具轮（无文本）也一并跳过。
 * 预算：最多最近 MAX_REPLAY_MESSAGES 条、合计 MAX_REPLAY_CHARS 字符，从最新往回取；
 * 当前用户消息刚落库，必在回放内且位于末尾。相邻同 role（纯工具轮被跳过/预算截断造成）
 * 需自合并——实测 AI SDK 不合并，而部分 provider 拒绝连续同角色消息。
 */
function buildReplayMessages(
  rows: MessageRow[]
): { role: 'user' | 'assistant'; content: string }[] {
  const picked: { role: 'user' | 'assistant'; content: string }[] = [];
  let total = 0;
  for (let i = rows.length - 1; i >= 0 && picked.length < MAX_REPLAY_MESSAGES; i--) {
    const row = rows[i]!;
    if (row.role === 'assistant' && row.content.trim() === '') continue;
    if (picked.length > 0 && total + row.content.length > MAX_REPLAY_CHARS) break;
    total += row.content.length;
    picked.push({ role: row.role, content: row.content });
  }
  picked.reverse();
  // 截断后若首条是 assistant（其对应的 user 引导已被裁掉），丢掉。
  if (picked[0]?.role === 'assistant') picked.shift();
  // 相邻同 role 合并为一条，保证 user/assistant 交替。
  const merged: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of picked) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content;
    else merged.push({ role: m.role, content: m.content });
  }
  return merged;
}

/**
 * 处理一次 /v1/chat 请求。校验、会话解析、用户消息落库在 SSE 之前完成（失败返回 JSON 错误）；
 * 之后进入 SSE 流，经 event_pump（单一发射点、按会话保序）逐条转发 AI SDK 事件，done 前落库完整 assistant 消息。
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

  // 会话解析：缺省新建，title 取首条用户消息前 20 字，scope 记讨论归属（已有会话沿用原归属）。
  let session: SessionRow | undefined;
  if (parsed.data.sessionId) {
    session = deps.store.getSession(parsed.data.sessionId);
    if (!session) {
      writeJson(res, 404, { error: '会话不存在: ' + parsed.data.sessionId });
      return;
    }
  } else {
    session = deps.store.createSession(text.trim().slice(0, 20), parsed.data.scope ?? '');
  }
  // 两个分支后 session 必非空
  const sessionId = session.id;

  // 用户消息先落库：即使客户端中途断连也不丢。
  deps.store.addMessage(sessionId, { role: 'user', content: text });

  const abort = new AbortController();
  const onClose = () => abort.abort();
  req.on('close', onClose);
  res.on('close', onClose);

  // 服务端超时：provider 挂起时也强制中止，避免请求无限挂着（客户端断连信号仍优先）。
  const timeoutSeconds = getLlmTimeoutSeconds();
  const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);

  const pump = new EventPump(res, sessionId);
  pump.start();
  try {
    const model = deps.modelForTier(tier);
    const options: Parameters<typeof streamText>[0] = {
      model,
      system: systemPrompt(parsed.data.workDir),
      messages: buildReplayMessages(deps.store.listMessages(sessionId)),
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: AbortSignal.any([abort.signal, timeoutSignal]),
    };
    if (deps.tools) options.tools = deps.tools;
    const result = streamText(options);

    let assistantText = '';
    const toolCalls: { id: string; name: string; args: unknown }[] = [];
    for await (const part of result.stream) {
      switch (part.type) {
        case 'text-delta':
          assistantText += part.text;
          pump.emit('text-delta', { delta: part.text });
          break;
        case 'tool-call': {
          const call = { id: part.toolCallId, name: part.toolName, args: part.input ?? {} };
          toolCalls.push(call);
          pump.emit('tool-call', call);
          break;
        }
        case 'tool-result':
          pump.emit('tool-result', { id: part.toolCallId, name: part.toolName, result: part.output ?? null });
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
      pump.end();
      return;
    }
    if (timeoutSignal.aborted) {
      pump.emit('error', { message: `LLM 请求超时（超过 ${timeoutSeconds} 秒）` });
      pump.end();
      return;
    }

    // done 前把完整 assistant 消息落库。
    const assistantMsg = deps.store.addMessage(sessionId, {
      role: 'assistant',
      content: assistantText,
      toolCalls,
    });
    pump.emit('done', { sessionId, messageId: assistantMsg.id });
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