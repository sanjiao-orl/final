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
import { HttpError, toPublicErrorMessage, writeJson } from './http.js';
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
  /**
   * 碰撞模式（决策 0013）：mode=collide 时契约层加「## 碰撞协议」、数据层加「## 讨论沉淀」。
   * 不传 = 现状全不变（零注入、零工具调用）。当前仅 collide 一个值，后续模式按需扩枚举。
   */
  mode: z.enum(['collide']).optional(),
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

/** decision_tail 工具名：core 侧碰撞模式讨论沉淀注入契约（domain 并行开发的裁决检索摘要工具）。 */
const DECISION_TAIL_TOOL = 'decision_tail';

/** 讨论沉淀注入字符预算（决策 0013：裁决全量不进上下文，只进检索摘要）。 */
const DECISION_INJECT_MAX_CHARS = 1500;

/**
 * 契约层注入字符预算：skill 清单 / persona 正文 / 碰撞协议各自上限。
 * 与数据层截断口径对齐——远超上下文无益且挤占对话预算，超限截断并加省略标注，不再零预算零截断。
 */
const SKILL_LIST_INJECT_MAX_CHARS = 2000;
const PERSONA_INJECT_MAX_CHARS = 2000;
const COLLIDE_PROMPT_INJECT_MAX_CHARS = 2000;

/** 注入预算截断：超限截到 max 并追加省略标注（buildDecisionTailSection 同风格）。 */
function truncateInjection(text: string, max: number, label: string): string {
  return text.length > max ? `${text.slice(0, max)}\n…（${label}超 ${max} 字符，已截断）` : text;
}

/** 数据层注入（ledger_chapter_slice/decision_tail 的 MCP 工具调用）独立超时秒数缺省值：
 *  domain 挂起时不拖满 LLM 超时（600s）干等，到点降级跳过注入。DATA_INJECT_TIMEOUT_SECONDS 可覆盖，需为正数秒数。 */
const DEFAULT_DATA_INJECT_TIMEOUT_SECONDS = 15;

/** 读数据层注入独立超时秒数（config.ts 口径的本地版：env 可覆盖，非法即抛错）。 */
function getDataInjectTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DATA_INJECT_TIMEOUT_SECONDS;
  if (!raw) return DEFAULT_DATA_INJECT_TIMEOUT_SECONDS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`DATA_INJECT_TIMEOUT_SECONDS 取值非法: ${raw}（需为正数秒数）`);
  }
  return value;
}

interface ChapterSlice {
  found: boolean;
  slice: string;
  chapterTitle: string | null;
}

/** decision_tail 结果结构：total=裁决总数，lines=摘要行（按工具返回序）。 */
interface DecisionTail {
  total: number;
  lines: string[];
}

/**
 * 组装系统提示：按决策 0010 注入面分层——契约层（prompt md + workDir 行 + skill 清单 + 碰撞协议(模式 collide 时)）→
 * 姿态层（角色，request 带 persona 且按名能找到才注，无则零注入）→ 数据层（声口摘要 + 本章账本切片 + 讨论沉淀（模式 collide 时），缺则静默跳过）。
 * 数据层账本切片与讨论沉淀需要调 domain 工具，故为 async（可挂 abortSignal，超时/断连可中止）。
 */
async function systemPrompt(
  workDir: string | undefined,
  chapter: string | undefined,
  tools: ToolSet | undefined,
  abortSignal: AbortSignal,
  persona?: string,
  collide?: boolean
): Promise<string> {
  // 每次请求现取 prompt（mtime 感知热重载，改文件即生效），不再用模块级常量缓存。
  // 契约层：提示词文件 + workDir 行 + skill 清单 + 碰撞协议（现有不动）
  let prompt = loadPrompt('chat');
  if (workDir) {
    prompt += `\n当前打开的作品文件夹：${workDir}。调用领域工具时 workDir 参数一律使用这个路径。`;
    const skills = listSkills(workDir);
    if (skills.length > 0) {
      const lines = truncateInjection(
        skills.map((s) => `- ${s.name}:${s.description}`).join('\n'),
        SKILL_LIST_INJECT_MAX_CHARS,
        'skill 清单'
      );
      prompt += `\n\n## 可用 skill\n${lines}\n需要时调用领域工具 skill_read 传入 name 获取该 skill 正文并按其执行。`;
    }
    // 碰撞模式：契约层加「## 碰撞协议」（决策 0013）——skill 清单之后、姿态层之前，为姿态层角色提供碰撞流程与格式契约
    if (collide) {
      prompt += `\n\n## 碰撞协议\n${truncateInjection(loadPrompt('collide'), COLLIDE_PROMPT_INJECT_MAX_CHARS, '碰撞协议')}`;
    }
  }
  // 姿态层：角色注入（决策 0010）——request 带 persona 且按名能找到才注正文段；找不到/无 persona = 零注入
  if (persona) {
    const personaBody = loadPersona(persona, workDir);
    if (personaBody) {
      prompt += `\n\n## 当前角色\n${truncateInjection(personaBody, PERSONA_INJECT_MAX_CHARS, '角色正文')}`;
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
  // 数据层 c：讨论沉淀（最近裁决）——碰撞模式才注（mode=collide 且有 workDir 且工具可用）；缺/报错/超时 warn 降级，decisions.md 无记录则零注入
  if (collide && workDir && tools) {
    const tail = await fetchDecisionTail(workDir, chapter, tools, abortSignal);
    if (tail && tail.lines.length > 0) {
      prompt += buildDecisionTailSection(tail);
    }
  }
  return prompt;
}

/**
 * 数据层账本切片：仿 review.ts 的 MCP 工具调用模式调 ledger_chapter_slice。
 * 挂独立注入超时（AbortSignal.any[断连/整体信号, 注入定时]）：domain 挂起时最多等 DATA_INJECT_TIMEOUT_SECONDS
 * （缺省 15s），到点降级跳过——不拖满 LLM 超时干等，也不会被误归因为「LLM 请求超时」。
 * 工具缺失/调用失败（含注入超时）→ console.warn 并返回 undefined（跳过注入，不阻断聊天）。
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
  const injectSeconds = getDataInjectTimeoutSeconds();
  const injectSignal = AbortSignal.any([abortSignal, AbortSignal.timeout(injectSeconds * 1000)]);
  try {
    const result: unknown = await tool.execute({ workDir, chapterRelPath: chapter } as never, {
      toolCallId: 'chat-ledger-chapter-slice',
      messages: [],
      context: undefined,
      abortSignal: injectSignal,
    });
    return extractChapterSlice(result);
  } catch (err) {
    if (abortSignal.aborted) return undefined; // 客户端断连/整体超时：静默跳过（外层已有归因）
    if (injectSignal.aborted) {
      console.warn(
        `[chat] 数据层注入超时：ledger_chapter_slice ${injectSeconds} 秒无响应（domain 数据层挂起），跳过本章账本切片注入（非 LLM 请求超时）`
      );
      return undefined;
    }
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

/**
 * 数据层讨论沉淀：碰撞模式才注（mode=collide 且有 workDir）。仿 fetchChapterSlice 调 decision_tail 取最近裁决摘要。
 * 入参 { workDir, limit: 20 }，挂载章（chapter）缺省不传；与账本切片同口径：独立注入超时（缺省 15s），
 * 到点 warn 明确归因为数据层超时（非 LLM 请求超时）并返回 undefined（跳过注入，不阻断聊天）。
 */
async function fetchDecisionTail(
  workDir: string,
  chapter: string | undefined,
  tools: ToolSet,
  abortSignal: AbortSignal
): Promise<DecisionTail | undefined> {
  const tool = tools[DECISION_TAIL_TOOL];
  if (!tool?.execute) {
    console.warn('[chat] decision_tail 工具不可用（domain MCP 未连接或工具不存在），跳过讨论沉淀注入');
    return undefined;
  }
  const injectSeconds = getDataInjectTimeoutSeconds();
  const injectSignal = AbortSignal.any([abortSignal, AbortSignal.timeout(injectSeconds * 1000)]);
  try {
    const input: Record<string, unknown> = { workDir, limit: 20 };
    if (chapter) input.chapter = chapter;
    const result: unknown = await tool.execute(input as never, {
      toolCallId: 'chat-decision-tail',
      messages: [],
      context: undefined,
      abortSignal: injectSignal,
    });
    return extractDecisionTail(result);
  } catch (err) {
    if (abortSignal.aborted) return undefined; // 客户端断连/整体超时：静默跳过（外层已有归因）
    if (injectSignal.aborted) {
      console.warn(
        `[chat] 数据层注入超时：decision_tail ${injectSeconds} 秒无响应（domain 数据层挂起），跳过讨论沉淀注入（非 LLM 请求超时）`
      );
      return undefined;
    }
    console.warn(
      '[chat] decision_tail 调用失败，跳过讨论沉淀注入：',
      err instanceof Error ? err.message : err
    );
    return undefined;
  }
}

/** 从 decision_tail 结果提取 {total, lines}：兼容 structuredContent / 直接返回对象 / content text JSON 三态（extractChapterSlice 同口径）；格式不识别返回 undefined（降级跳过）。 */
function extractDecisionTail(result: unknown): DecisionTail | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as {
    isError?: unknown;
    structuredContent?: unknown;
    total?: unknown;
    lines?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = r.content?.find((c) => c && c.type === 'text' && typeof c.text === 'string')?.text;
  if (r.isError) {
    console.warn(`[chat] decision_tail 执行失败：${text ?? '未知错误'}`);
    return undefined;
  }

  const candidates: unknown[] = [];
  if (r.structuredContent !== undefined) candidates.push(r.structuredContent);
  if (r.total !== undefined || r.lines !== undefined) candidates.push(r);
  if (text !== undefined) {
    try {
      candidates.push(JSON.parse(text));
    } catch {
      candidates.push(text);
    }
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      const c = candidate as { total?: unknown; lines?: unknown };
      if (Array.isArray(c.lines) && c.lines.every((l) => typeof l === 'string')) {
        return {
          total: typeof c.total === 'number' && Number.isFinite(c.total) ? c.total : (c.lines as string[]).length,
          lines: c.lines as string[],
        };
      }
    }
  }
  return undefined;
}

/** 组装「## 讨论沉淀（最近裁决）」节：lines 合并超预算截断并加省略标注；total > lines.length（有摘要折叠）时在节末尾追加条数说明。 */
function buildDecisionTailSection(tail: DecisionTail): string {
  let content = tail.lines.join('\n');
  if (content.length > DECISION_INJECT_MAX_CHARS) {
    content = content.slice(0, DECISION_INJECT_MAX_CHARS) + '\n…（已截断，完整记录见 editorial_notes/decisions.md）';
  }
  if (tail.total > tail.lines.length) {
    content += `\n（共 ${tail.total} 条，以上为摘要）`;
  }
  return `\n\n## 讨论沉淀（最近裁决）\n${content}`;
}

/** 多轮工具调用的步数上限。 */
const MAX_STEPS = 8;

/** 跨对话记忆：回放给模型的历史消息条数上限（含当前用户消息；成对回放时 assistant+tool 算两条）。 */
const MAX_REPLAY_MESSAGES = 20;

/** 跨对话记忆：回放历史的总字符预算（正文+工具结果），超限从最旧处截断。 */
const MAX_REPLAY_CHARS = 40_000;

/**
 * 工具结果落库上限：单条结果最多存 20_000 字符（防爆兜底，整章正文也够放），
 * 仍放在 tool_calls JSON blob 元素的 result 字段。落库与回放分离：存尽量全量，
 * 回放再按工具分档截断——存得全才给得起；截断时末尾追加省略标注。
 */
const TOOL_RESULT_STORE_MAX_CHARS = 20_000;

/** 工具结果回放默认档：状态/计数类小结果 500 足够。 */
const TOOL_RESULT_REPLAY_DEFAULT_CHARS = 500;

/**
 * 工具结果回放内容档：返回正文/长文本的工具给 3000。
 * 取舍实录(v5 验收实测):500 时 read_chapter 整章正文在开篇处被截,模型公开抱怨"只读到开头";
 * 仍受 MAX_REPLAY_CHARS 总预算兜底(整组裁,不留孤儿)。
 */
const TOOL_RESULT_REPLAY_CONTENT_CHARS = 3_000;

/** 内容类工具（返回正文/长文本）清单：回放用内容档，其余工具走默认档。 */
const CONTENT_REPLAY_TOOLS = new Set([
  'read_chapter',
  'read_snapshot',
  'ledger_read',
  'ledger_slice',
  'ledger_chapter_slice',
  'search_content',
  'skill_read',
]);

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

/** 工具结果截断：超限截到 max 并追加省略标注，提示模型可再调工具取全量。 */
function truncateToolResult(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断，可再调工具取全量）` : text;
}

/** 回放截断按工具分档：内容类工具给内容档，其余给默认档。 */
function replayLimitFor(toolName: string): number {
  return CONTENT_REPLAY_TOOLS.has(toolName)
    ? TOOL_RESULT_REPLAY_CONTENT_CHARS
    : TOOL_RESULT_REPLAY_DEFAULT_CHARS;
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
      output: { type: 'text', value: truncateToolResult(c.result, replayLimitFor(c.name)) },
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
 * per-session 在飞锁：同 session 并发 /v1/chat 会互见对方未答问题、消息序错乱（回放交叉污染，P2）。
 * 壳层 UI 拦了双击，HTTP 层这里补内存级互斥——同 sessionId 已在飞时第二个请求 409 拒绝，
 * 等第一个完成或停止后再发；不同 sessionId 互不影响。键是请求落库后的实际 session.id（新建会话天然不撞）。
 */
const inFlightSessions = new Set<string>();

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

  // 在飞锁：拿锁在落库之前（409 时不给该会话附加任何副作用），释放放在最外层 finally——
  // 无论正常完成/断连/超时/抛错哪条出口，锁都归还，下一请求才可再发。
  if (inFlightSessions.has(sessionId)) {
    throw new HttpError(409, '该会话有正在进行的对话，请先等待其完成或停止');
  }
  inFlightSessions.add(sessionId);
  try {
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
    // 统一中止信号：服务端超时 + 客户端断连；先于 streamText 的数据层注入调用另挂更短的独立注入超时
    // （见 fetchChapterSlice/fetchDecisionTail——domain 挂起时按注入超时降级，不占用 LLM 超时预算）。
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
      // 分层组装：契约层 + 姿态层（角色）+ 数据层（声口摘要/本章账本切片/讨论沉淀，见 systemPrompt；mode=collide 时加碰撞协议与讨论沉淀）。
      system: await systemPrompt(
        workDir,
        parsed.data.chapter,
        deps.tools,
        combinedSignal,
        parsed.data.persona,
        parsed.data.mode === 'collide'
      ),
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
          const resultText = truncateToolResult(toolResultToText(part.output ?? null), TOOL_RESULT_STORE_MAX_CHARS);
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
  } finally {
    // 在飞锁归还：内层 try/catch/finally 的每条出口（正常/断连/超时/抛错）都走到这里释放，
    // 保证同会话下一个请求能立即再发；若内层抛错被这里吞掉，则连同上面 try 一起交由路由层 catch。
    inFlightSessions.delete(sessionId);
  }
}