// 模块职责：POST /v1/chat 的 SSE 聊天管道——落库用户消息 → streamText 多轮工具流 → 逐条转发 SSE → done 前落库完整 assistant 消息；客户端断连中止 LLM 请求。
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolCallPart,
  type ToolResultPart,
  type ToolSet,
} from 'ai';
import { z } from 'zod';
import type { CandidateStore } from './candidate-store.js';
import type { MessageRow, SessionRow, SessionStore } from './session-store.js';
import { getLlmTimeoutSeconds, type Tier } from './config.js';
import { EventPump } from './event-pump.js';
import { toPublicErrorMessage, writeJson } from './http.js';
import { listSkills, loadPersona, loadPrompt, loadStyleSummary } from './prompts.js';
import { normalizeWorkDir } from './workdir.js';

export const chatBodySchema = z.object({
  sessionId: z.string().uuid().optional(),
  text: z.string().min(1).max(20_000),
  tier: z.enum(['writing', 'background']).optional(),
  /**
   * 壳当前打开的作品文件夹绝对路径：拼进系统提示，让模型调工具时直接用。
   * 上限 500 字符并拒绝控制字符（换行/制表符等）——目录名会原样拼进系统提示，控制字符可破出提示行（注入面）。
   */
  workDir: z
    .string()
    .min(1)
    .max(500)
    .refine((s) => !/[\x00-\x1f\x7f]/.test(s), '不能包含控制字符')
    .optional(),
  /** 新建会话的讨论归属：'' = 无归属；章 relPath = 章节内讨论。已存在的会话忽略此字段。 */
  scope: z.string().max(500).optional(),
  /**
   * 会话挂载章的 relPath（manuscript/ 内 .md）：壳在章挂载会话的每条请求带出，
   * 供数据层账本切片注入（ledger_chapter_slice）。上限 500 字符并拒绝控制字符——口径同 workDir
   * （章 relPath 会原样拼进系统提示，控制字符可破出提示行，注入面）。
   */
  chapter: z
    .string()
    .max(500)
    .refine((s) => !/[\x00-\x1f\x7f]/.test(s), '不能包含控制字符')
    .optional(),
  /**
   * 姿态层角色名（决策 0010）：按名从角色库解析正文，拼系统提示「## 当前角色」段（契约层之后、数据层之前）。
   * 上限 100 字符并拒绝控制字符——口径同 workDir；无 persona 或按名找不到 = 零注入。
   */
  persona: z
    .string()
    .min(1)
    .max(100)
    .refine((s) => !/[\x00-\x1f\x7f]/.test(s), '不能包含控制字符')
    .optional(),
});
export type ChatBody = z.infer<typeof chatBodySchema>;

export interface ChatDeps {
  store: SessionStore;
  /** 暂存候选库：chat 本地工具 stage_chapter_proposal 的落库目标（AI 产出先进暂存区，铁律）。 */
  candidates: CandidateStore;
  /** 按档位返回模型；测试注入 mock。 */
  modelForTier: (tier: Tier) => LanguageModel;
  /** MCP 领域工具，连不上时为 undefined。 */
  tools: ToolSet | undefined;
  /** MCP 当前是否可用；缺省视为可用（保持无 MCP 注入时的旧行为）。 */
  toolsAvailable?: () => boolean;
}

/** ledger_chapter_slice 工具名：core 侧数据层注入契约（domain 并行开发的账本按章切片工具）。 */
const LEDGER_CHAPTER_SLICE_TOOL = 'ledger_chapter_slice';

interface ChapterSlice {
  found: boolean;
  slice: string;
  chapterTitle: string | null;
}

/**
 * 组装系统提示：按决策 0010 注入面分层——契约层（prompt md + workDir 行 + skill 清单，现有不动）→
 * 姿态层（角色，request 带 persona 且按名能找到才注，无则零注入）→ 数据层（声口摘要 + 本章账本切片，缺则静默跳过）。
 * 数据层账本切片需要调 domain 工具，故为 async（可挂 abortSignal，超时/断连可中止）。
 */
async function systemPrompt(
  workDir: string | undefined,
  chapter: string | undefined,
  tools: ToolSet | undefined,
  abortSignal: AbortSignal,
  persona?: string
): Promise<string> {
  // 每次请求现取 prompt（mtime 感知热重载，改文件即生效），不再用模块级常量缓存。
  // 契约层：提示词文件 + workDir 行 + skill 清单（现有不动）
  let prompt = loadPrompt('chat');
  if (workDir) {
    prompt += `\n当前打开的作品文件夹：${workDir}。调用领域工具时 workDir 参数一律使用这个路径。`;
    const skills = listSkills(workDir);
    if (skills.length > 0) {
      const lines = skills.map((s) => `- ${s.name}:${s.description}`).join('\n');
      prompt += `\n\n## 可用 skill\n${lines}\n需要时调用领域工具 skill_read 传入 name 获取该 skill 正文并按其执行。`;
    }
  }
  // 姿态层：角色注入（决策 0010）——request 带 persona 且按名能找到才注正文段；找不到/无 persona = 零注入
  if (persona) {
    const personaBody = loadPersona(persona, workDir);
    if (personaBody) {
      prompt += `\n\n## 当前角色\n${personaBody}`;
    }
  }

  // 数据层 a：声口摘要（style.md 有摘要才注，缺则静默跳过）
  if (workDir) {
    const summary = loadStyleSummary(workDir);
    if (summary) {
      prompt += `\n\n## 声口摘要\n${summary}`;
    }
  }
  // 数据层 b：本章账本切片（章挂载会话 + domain 工具可用才注；工具缺失/报错/超时 warn 降级，不阻断聊天）
  if (workDir && chapter && tools) {
    const sliceResult = await fetchChapterSlice(workDir, chapter, tools, abortSignal);
    if (sliceResult?.found && sliceResult.slice) {
      prompt += `\n\n## 本章账本切片(${sliceResult.chapterTitle ?? chapter})\n仅含与当前章相关的账本条目，非全书。\n\n${sliceResult.slice}`;
    }
  }
  return prompt;
}

/**
 * 数据层账本切片：仿 review.ts 的 MCP 工具调用模式调 ledger_chapter_slice。
 * 工具缺失/调用失败（含超时）→ console.warn 并返回 undefined（跳过注入，不阻断聊天）。
 */
async function fetchChapterSlice(
  workDir: string,
  chapter: string,
  tools: ToolSet,
  abortSignal: AbortSignal
): Promise<ChapterSlice | undefined> {
  const tool = tools[LEDGER_CHAPTER_SLICE_TOOL];
  if (!tool?.execute) {
    console.warn('[chat] ledger_chapter_slice 工具不可用（domain MCP 未连接或工具不存在），跳过本章账本切片注入');
    return undefined;
  }
  try {
    const result: unknown = await tool.execute({ workDir, chapterRelPath: chapter } as never, {
      toolCallId: 'chat-ledger-chapter-slice',
      messages: [],
      context: undefined,
      abortSignal,
    });
    return extractChapterSlice(result);
  } catch (err) {
    console.warn(
      '[chat] ledger_chapter_slice 调用失败，跳过本章账本切片注入：',
      err instanceof Error ? err.message : err
    );
    return undefined;
  }
}

/** 从 ledger_chapter_slice 结果提取 {found, slice, chapterTitle}：兼容 structuredContent / 直接返回对象 / content text JSON 三态（review.ts extractSlice 同口径）；格式不识别返回 undefined（降级跳过）。 */
function extractChapterSlice(result: unknown): ChapterSlice | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as {
    isError?: unknown;
    structuredContent?: unknown;
    found?: unknown;
    slice?: unknown;
    chapterTitle?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = r.content?.find((c) => c && c.type === 'text' && typeof c.text === 'string')?.text;
  if (r.isError) {
    console.warn(`[chat] ledger_chapter_slice 执行失败：${text ?? '未知错误'}`);
    return undefined;
  }

  const candidates: unknown[] = [];
  if (r.structuredContent !== undefined) candidates.push(r.structuredContent);
  if (r.found !== undefined || r.slice !== undefined || r.chapterTitle !== undefined) candidates.push(r);
  if (text !== undefined) {
    try {
      candidates.push(JSON.parse(text));
    } catch {
      candidates.push(text);
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) return { found: true, slice: trimmed, chapterTitle: null };
      continue;
    }
    if (candidate && typeof candidate === 'object') {
      const c = candidate as { found?: unknown; slice?: unknown; chapterTitle?: unknown };
      if (typeof c.slice === 'string') {
        return {
          found: typeof c.found === 'boolean' ? c.found : c.slice !== '',
          slice: c.slice,
          chapterTitle: typeof c.chapterTitle === 'string' && c.chapterTitle.length > 0 ? c.chapterTitle : null,
        };
      }
    }
  }
  return undefined;
}

/** 多轮工具调用的步数上限。 */
const MAX_STEPS = 8;

/** 跨对话记忆：回放给模型的历史消息条数上限（含当前用户消息；成对回放时 assistant+tool 算两条）。 */
const MAX_REPLAY_MESSAGES = 20;

/** 跨对话记忆：回放历史的总字符预算（正文+工具结果），超限从最旧处截断。 */
const MAX_REPLAY_CHARS = 25_000;

/**
 * 工具结果截断单值：落库与回放同用一个上限 500——存什么回放什么，不做二次截断。
 * 落库：单条结果最多存 500 字符，仍放在 tool_calls JSON blob 元素的 result 字段。
 * 取舍实录(v5 验收实测):300 时 read_chapter 整章正文在开篇处被截，模型公开抱怨"只读到开头",
 * 对最高频内容工具偏紧;500 仍受 MAX_REPLAY_CHARS 总预算兜底(整组裁,不留孤儿),语义更直白。
 */
const TOOL_RESULT_MAX_CHARS = 500;

/**
 * 跨对话记忆：把会话历史回放成 AI SDK v7 ModelMessage[]。
 * - 历史 assistant 行 toolCalls 全部带 result 时，组装成对的 assistant(tool-call parts)+tool(tool-result parts)，
 *   让跨轮模型读到上次工具结果；纯工具轮（content 为空）以 tool-call parts 数组回放。
 * - 旧数据（无 result）或部分缺 result 时，整轮回退到 toolSummary 摘要行，不混合拼半对。
 * 预算：最多最近 MAX_REPLAY_MESSAGES 条输出消息、合计 MAX_REPLAY_CHARS 字符（正文+回放结果），从最新往回取；
 * 当前用户消息刚落库，必在回放内且位于末尾。截断后首条若不是 user 则成对裁掉，避免孤儿 tool-call/tool-result。
 * 相邻同 role 的字符串消息需自合并——实测 AI SDK 不合并，而部分 provider 拒绝连续同角色消息。
 */

/** 工具调用摘要：把 toolCalls（unknown[]，运行时收窄：元素须为对象且有 string name）拼成一行提示文本；参数 JSON 超 100 字符截断。 */
function toolSummary(toolCalls: unknown[]): string {
  const names: string[] = [];
  for (const call of toolCalls) {
    if (typeof call !== 'object' || call === null) continue;
    const c = call as { name?: unknown; args?: unknown };
    if (typeof c.name !== 'string') continue;
    let argsText = '{}';
    try {
      argsText = JSON.stringify(c.args ?? {});
    } catch {
      argsText = '{}';
    }
    if (argsText.length > 100) argsText = argsText.slice(0, 100) + '…';
    names.push(`${c.name}(${argsText})`);
  }
  return names.length > 0 ? `[工具调用] ${names.join('、')}` : '';
}

/** 工具结果转文本：string 原样返回；其余 JSON 序列化（对象/数组等），不可序列化值走 String 兜底。 */
function toolResultToText(output: unknown): string {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output;
  try {
    const json = JSON.stringify(output);
    if (json !== undefined) return json;
  } catch {
    // 不可序列化值走 String 兜底
  }
  return String(output);
}

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

interface ParsedToolCall {
  id: string;
  name: string;
  args: unknown;
  result: string;
}

/** 仅当 toolCalls 每个元素都是可组装的 tool-call 且全部带 string result 时返回解析结果；否则返回 null（整轮回退摘要）。 */
function parsePairedToolCalls(toolCalls: unknown[]): ParsedToolCall[] | null {
  const parsed: ParsedToolCall[] = [];
  for (const call of toolCalls) {
    if (typeof call !== 'object' || call === null) return null;
    const c = call as { id?: unknown; name?: unknown; args?: unknown; result?: unknown };
    if (typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.result !== 'string') return null;
    parsed.push({ id: c.id, name: c.name, args: c.args ?? {}, result: c.result });
  }
  return parsed;
}

function buildReplayRow(row: MessageRow): { messages: ModelMessage[]; chars: number } | null {
  if (row.role === 'user') {
    return { messages: [{ role: 'user', content: row.content }], chars: row.content.length };
  }

  // assistant 无工具调用：空文本跳过，否则按普通文本回放。
  if (row.toolCalls.length === 0) {
    if (row.content.trim() === '') return null;
    return { messages: [{ role: 'assistant', content: row.content }], chars: row.content.length };
  }

  // 全部带 result → 组装成对 tool-call / tool-result。
  const calls = parsePairedToolCalls(row.toolCalls);
  if (calls) {
    const toolCallParts: ToolCallPart[] = calls.map((c) => ({
      type: 'tool-call',
      toolCallId: c.id,
      toolName: c.name,
      input: c.args,
    }));
    const toolResultParts: ToolResultPart[] = calls.map((c) => ({
      type: 'tool-result',
      toolCallId: c.id,
      toolName: c.name,
      output: { type: 'text', value: truncateText(c.result, TOOL_RESULT_MAX_CHARS) },
    }));
    const assistantMessage: ModelMessage =
      row.content.trim() === ''
        ? { role: 'assistant', content: toolCallParts }
        : { role: 'assistant', content: [{ type: 'text', text: row.content }, ...toolCallParts] };
    const toolMessage: ModelMessage = { role: 'tool', content: toolResultParts };
    const resultChars = toolResultParts.reduce(
      (n, p) => n + (p.output.type === 'text' ? p.output.value.length : 0),
      0
    );
    return {
      messages: [assistantMessage, toolMessage],
      chars: row.content.length + resultChars,
    };
  }

  // 旧数据/部分缺 result → 整轮回退摘要行（保持既有行为）。
  const summary = toolSummary(row.toolCalls);
  if (!summary && row.content.trim() === '') return null;
  const content = row.content === '' ? summary : `${row.content}\n${summary}`;
  return { messages: [{ role: 'assistant', content }], chars: content.length };
}

function buildReplayMessages(rows: MessageRow[]): ModelMessage[] {
  const pickedRows: { messages: ModelMessage[]; chars: number }[] = [];
  let total = 0;
  let messageCount = 0;
  for (let i = rows.length - 1; i >= 0 && messageCount < MAX_REPLAY_MESSAGES; i--) {
    const built = buildReplayRow(rows[i]!);
    if (!built) continue;
    // 成对消息不可拆半：整组超条数/字符预算就不放，避免孤儿 tool-call 或 tool-result。
    if (messageCount > 0 && messageCount + built.messages.length > MAX_REPLAY_MESSAGES) break;
    if (messageCount > 0 && total + built.chars > MAX_REPLAY_CHARS) break;
    total += built.chars;
    messageCount += built.messages.length;
    pickedRows.push(built);
  }
  pickedRows.reverse();
  const picked = pickedRows.flatMap((built) => built.messages);
  // 截断后首条若不是 user（如 assistant/tool 的引导 user 已被裁掉），成对丢弃直到从 user 开始。
  while (picked.length > 0 && picked[0]!.role !== 'user') picked.shift();
  // 相邻同 role 的字符串消息合并为一条；成对消息是数组 content，不参与合并。
  const merged: ModelMessage[] = [];
  for (const m of picked) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.role === m.role &&
      typeof last.content === 'string' &&
      typeof m.content === 'string'
    ) {
      merged[merged.length - 1] = {
        role: last.role,
        content: `${last.content}\n${m.content}`,
      } as ModelMessage;
    } else {
      merged.push(m);
    }
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
    writeJson(res, 400, { error: '请求体不合法: ' + parsed.error.issues.map((i) => i.message).join('; ') }, req.headers.origin);
    return;
  }
  const { text } = parsed.data;
  const tier = parsed.data.tier ?? 'writing';
  // workDir 清洗：归一并校验存在且为目录（不合法抛 400，见 normalizeWorkDir）。放在任何会话副作用之前。
  const workDir = parsed.data.workDir ? normalizeWorkDir(parsed.data.workDir) : undefined;

  // 会话解析：缺省新建，title 取首条用户消息前 20 字，scope 记讨论归属（已有会话沿用原归属）。
  let session: SessionRow | undefined;
  if (parsed.data.sessionId) {
    session = deps.store.getSession(parsed.data.sessionId);
    if (!session) {
      writeJson(res, 404, { error: '会话不存在: ' + parsed.data.sessionId }, req.headers.origin);
      return;
    }
  } else {
    session = deps.store.createSession(text.trim().slice(0, 20), parsed.data.scope ?? '');
  }
  // 两个分支后 session 必非空
  const sessionId = session.id;

  // 用户消息先落库：即使客户端中途断连也不丢。
  deps.store.addMessage(sessionId, { role: 'user', content: text });

  // 断连中止：只挂 res.on('close')——请求体在进入本函数前已被路由层读完，
  // 此刻再注册 req.on('close') 已无意义（request 侧事件早已完成），只会误导排查。
  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.on('close', onClose);

  // 服务端超时：provider 挂起时也强制中止，避免请求无限挂着（客户端断连信号仍优先）。
  const timeoutSeconds = getLlmTimeoutSeconds();
  const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);

  const pump = new EventPump(res, sessionId, req.headers.origin);
  pump.start();
  let assistantText = '';
  const toolCalls: { id: string; name: string; args: unknown; result?: string }[] = [];
  /** 失败轮落库：非断连且已产出内容时，把部分 assistant 消息落库再发 error；落库失败只记 stderr，不掩盖原始错误。 */
  const persistPartial = (): void => {
    if (abort.signal.aborted || (assistantText === '' && toolCalls.length === 0)) return;
    try {
      deps.store.addMessage(sessionId, { role: 'assistant', content: assistantText, toolCalls });
    } catch (e) {
      console.error('落库失败轮 assistant 消息失败:', e);
    }
  };
  try {
    const model = deps.modelForTier(tier);
    // 统一中止信号：服务端超时 + 客户端断连，先于 streamText 的数据层账本切片调用也挂在这里（超时即中止）。
    const combinedSignal = AbortSignal.any([abort.signal, timeoutSignal]);
    // 本地暂存提案工具（非 MCP）：AI 产出先进暂存区，作者批量采纳后才落盘（铁律回归）。只在本次请求里构造——
    // 闭包当前会话 id 与挂载章（body.chapter）；MCP 断连时本地工具仍可用（见下方 options.tools 合并）。
    const stageChapterProposal = tool({
      description:
        '把讨论定稿的正文提案送进暂存区（作者批量采纳后才落盘）。何时用：新写/续写/大段改写章正文一律先调本工具，不要在对话里贴大段正文代替。何时不用：作者明确指令直接写入章文件时用 write_chapter；记录设定/伏笔/知情/时间线用 ledger_upsert；书级元数据用 write_meta。',
      inputSchema: z.object({
        proposed: z.string().min(1).max(20_000).describe('提案正文（纯正文，不含 frontmatter）'),
        mode: z
          .enum(['append', 'replace_all', 'replace'])
          .default('append')
          .describe('append=追加章正文末尾；replace_all=替换整章正文；replace=锚定替换'),
        original: z.string().describe('mode=replace 时必填：本章中将被替换的原文（锚定）').optional(),
        chapter: z
          .string()
          .describe('目标章 relPath（manuscript/ 内 .md）；缺省用本请求 chat body 的 chapter 字段（挂载章）')
          .optional(),
        instruction: z.string().max(2_000).describe('提案说明').optional(),
      }),
      execute: async (input) => {
        const chapter = input.chapter ?? parsed.data.chapter;
        if (!chapter) {
          return '需要指定目标章：请用 list_structure 查询 manuscript/ 内的 .md relPath 填入 chapter 参数，或在聊天挂载章（请求带 chapter 字段）后重试。本次未创建候选。';
        }
        if (input.mode === 'replace' && !input.original) {
          return 'mode=replace 需要 original 锚定原文：请提供本章中将被替换的原文。本次未创建候选。';
        }
        const candidate = deps.candidates.create({
          chapter,
          original: input.original ?? '',
          proposed: input.proposed,
          instruction: input.instruction ?? '',
          sessionId,
          kind: input.mode,
        });
        return `已进暂存区（候选 id ${candidate.id}），等作者批量采纳后落盘`;
      },
    });
    const options: Parameters<typeof streamText>[0] = {
      model,
      // 分层组装：契约层 + 姿态层（角色）+ 数据层（声口摘要/本章账本切片，见 systemPrompt）。
      system: await systemPrompt(workDir, parsed.data.chapter, deps.tools, combinedSignal, parsed.data.persona),
      messages: buildReplayMessages(deps.store.listMessages(sessionId)),
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: combinedSignal,
    };
    // 本地工具与领域工具合并：MCP 断连（deps.tools 为 undefined）时本地暂存提案仍可用。
    options.tools = { ...(deps.tools ?? {}), stage_chapter_proposal: stageChapterProposal };
    const result = streamText(options);

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
        case 'tool-result': {
          const resultText = truncateText(toolResultToText(part.output ?? null), TOOL_RESULT_MAX_CHARS);
          const call = toolCalls.find((c) => c.id === part.toolCallId);
          if (call) call.result = resultText;
          pump.emit('tool-result', { id: part.toolCallId, name: part.toolName, result: part.output ?? null });
          break;
        }
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
      persistPartial();
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
      persistPartial();
      pump.emit('error', { message: `LLM 请求超时（超过 ${timeoutSeconds} 秒）` });
      pump.end();
      return;
    }
    // 错误脱敏：非业务错误（provider 内部异常等）只回稳定占位，原始细节已写 stderr。
    persistPartial();
    pump.emit('error', { message: toPublicErrorMessage(err) });
    pump.end();
  } finally {
    res.off('close', onClose);
  }
}