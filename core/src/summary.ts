// 模块职责：POST /v1/summary/generate 的章摘要生成管道（便宜档）——read_chapter 取章 →
// background 档一次性结构化输出（generateText + Output.object，SDK 按 responseFormat 约束并 zod 校验）
// → word_count 取字数（非空白字符口径，domain 单一事实源）→ write_chapter_summary 落 domain
// 导生缓存（机检字段首写冻结语义由 domain 负责）→ read_chapter_summaries 回读取 generatedAt。
// 工具缺失/失败/模型输出不合规一律抛 HttpError(502)，由端点层透传中文 message。
import {
  generateText,
  JSONParseError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  TypeValidationError,
  type LanguageModel,
  type ToolSet,
} from 'ai';
import { z } from 'zod';
import { getLlmTimeoutSeconds, type Tier } from './config.js';
import { HttpError } from './http.js';
import { loadPrompt } from './prompts.js';
import { callDomainTool, unwrapToolPayload } from './tool-call.js';

/** 摘要输入正文上限：超长截断并标注（便宜档上下文有限，整章网文常超）。 */
export const SUMMARY_BODY_MAX_CHARS = 12_000;

export interface SummaryDeps {
  /** background（便宜）档模型。 */
  modelForTier: (tier: Tier) => LanguageModel;
  /** MCP 领域工具注册表；read_chapter/word_count/write_chapter_summary/read_chapter_summaries 从这里取。 */
  tools: ToolSet | undefined;
}

/** 结构化输出契约：与 prompts/summary.md 的输出要求同口径，tension 越界/sceneType 出枚举由 zod 拒。 */
const summaryOutputSchema = z.object({
  summary: z.string(),
  tension: z.number().int().min(1).max(10),
  sceneType: z.enum(['战斗', '日常', '过渡', '高潮', '悬念', '情感', '其他']),
});
export type SummaryOutput = z.infer<typeof summaryOutputSchema>;

export interface SummaryRecord {
  relPath: string;
  summary: string;
  tension: number;
  sceneType: string;
  wordCount: number;
  generatedAt: string;
}

export interface ChapterSummaryResult {
  ok: true;
  /** true = 本次传入的机检字段因旧值已存在被 domain 冻结未更新（重建场景）。 */
  frozen: boolean;
  record: SummaryRecord;
}

/**
 * 生成单章章摘要并落缓存。链路：read_chapter → LLM 结构化摘要 → word_count →
 * write_chapter_summary（domain 做冻结）→ 回读缓存取 generatedAt。
 * 任一环失败抛 HttpError（工具 502 / 模型输出 502 / LLM 超时 504）。
 */
export async function generateChapterSummary(
  deps: SummaryDeps,
  workDir: string,
  relPath: string,
  abortSignal?: AbortSignal
): Promise<ChapterSummaryResult> {
  // 1. 取章正文（body 不含 frontmatter；frontmatter.title 作章标题，缺省用 relPath 兜底）
  const chapterRaw = await callDomainTool(deps.tools, 'read_chapter', { workDir, relPath }, {
    toolCallId: 'summary-read-chapter',
    ...(abortSignal ? { abortSignal } : {}),
  });
  const chapter = unwrapToolPayload(chapterRaw);
  const { body, title } = readChapterFields(chapter);

  // 2. background 档一次性结构化输出（system 每次现取，mtime 热重载；abort+超时仿 review.ts）
  const timeoutSeconds = getLlmTimeoutSeconds();
  const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
  let output: SummaryOutput;
  try {
    const result = await generateText({
      model: deps.modelForTier('background'),
      system: loadPrompt('summary'),
      prompt: buildSummaryPrompt(title, relPath, body),
      output: Output.object({ schema: summaryOutputSchema }),
      abortSignal: AbortSignal.any([...(abortSignal ? [abortSignal] : []), timeoutSignal]),
    });
    output = await result.output;
  } catch (err) {
    if (timeoutSignal.aborted && !abortSignal?.aborted) {
      throw new HttpError(504, `LLM 请求超时（超过 ${timeoutSeconds} 秒）`);
    }
    // SDK 结构化输出失败统一 502（NoObjectGeneratedError.cause 为 JSONParseError/TypeValidationError）
    if (
      NoObjectGeneratedError.isInstance(err) ||
      NoOutputGeneratedError.isInstance(err) ||
      JSONParseError.isInstance(err) ||
      TypeValidationError.isInstance(err)
    ) {
      throw new HttpError(502, '模型输出不是合法的章摘要 JSON（需含 summary/tension/sceneType 且 tension 为 1-10 整数）');
    }
    throw err;
  }

  // 3. 字数统计走 domain word_count（非空白字符口径单一事实源）
  const wcRaw = await callDomainTool(deps.tools, 'word_count', { workDir, relPath }, {
    toolCallId: 'summary-word-count',
    ...(abortSignal ? { abortSignal } : {}),
  });
  const total = extractNumberField(unwrapToolPayload(wcRaw), 'total');
  if (total === undefined) throw new HttpError(502, 'word_count 工具返回结果无效');

  // 4. 落导生缓存（冻结语义由 domain 负责）；frozen 不可读按 false 容错
  const writeRaw = await callDomainTool(
    deps.tools,
    'write_chapter_summary',
    { workDir, relPath, summary: output.summary, tension: output.tension, sceneType: output.sceneType, wordCount: total },
    { toolCallId: 'summary-write', ...(abortSignal ? { abortSignal } : {}) }
  );
  const frozen = extractBooleanField(unwrapToolPayload(writeRaw), 'frozen') ?? false;

  // 5. 回读缓存取 generatedAt（write 工具不回传时间戳；回读失败降级当前时刻，不炸主链路）
  let generatedAt = new Date().toISOString();
  try {
    const readRaw = await callDomainTool(deps.tools, 'read_chapter_summaries', { workDir, relPath }, {
      toolCallId: 'summary-read-back',
      ...(abortSignal ? { abortSignal } : {}),
    });
    const record = extractSummaryRecord(unwrapToolPayload(readRaw), relPath);
    if (record?.generatedAt) generatedAt = record.generatedAt;
  } catch {
    console.warn('[summary] 摘要落盘后回读失败，generatedAt 用当前时刻兜底');
  }

  return {
    ok: true,
    frozen,
    record: {
      relPath,
      summary: output.summary,
      tension: output.tension,
      sceneType: output.sceneType,
      wordCount: total,
      generatedAt,
    },
  };
}

/** 拼 LLM 输入：`【章标题】…【正文】…`，正文超限截断并标注。 */
function buildSummaryPrompt(title: string, relPath: string, body: string): string {
  let text = body;
  if (text.length > SUMMARY_BODY_MAX_CHARS) {
    text = text.slice(0, SUMMARY_BODY_MAX_CHARS) + `\n…（正文超 ${SUMMARY_BODY_MAX_CHARS} 字已截断）`;
  }
  return `【章标题】${title || relPath}\n【正文】\n${text}`;
}

/** 从 read_chapter 结果收窄 body/title：结构不符抛 502。 */
function readChapterFields(payload: unknown): { body: string; title: string } {
  if (!payload || typeof payload !== 'object') throw new HttpError(502, 'read_chapter 工具返回结果无效');
  const p = payload as { body?: unknown; frontmatter?: unknown };
  if (typeof p.body !== 'string' || p.body.length === 0) {
    throw new HttpError(502, 'read_chapter 工具返回结果无效（缺 body）');
  }
  const fm = p.frontmatter;
  const title =
    fm && typeof fm === 'object' && typeof (fm as { title?: unknown }).title === 'string'
      ? (fm as { title: string }).title
      : '';
  return { body: p.body, title };
}

/** 从对象里取数字字段（undefined 容忍；非有限数字视为缺失）。 */
function extractNumberField(payload: unknown, key: string): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 从对象里取布尔字段（undefined 容忍）。 */
function extractBooleanField(payload: unknown, key: string): boolean | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** 从 read_chapter_summaries 结果取目标章记录（relPath 匹配优先，兜底首条）。 */
function extractSummaryRecord(payload: unknown, relPath: string): { generatedAt?: string } | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const summaries = (payload as { summaries?: unknown }).summaries;
  if (!Array.isArray(summaries)) return undefined;
  const match = summaries.find(
    (s) => s && typeof s === 'object' && (s as { relPath?: unknown }).relPath === relPath
  );
  const rec = (match ?? summaries.find((s) => s && typeof s === 'object')) as
    | { generatedAt?: unknown }
    | undefined;
  if (!rec) return undefined;
  return typeof rec.generatedAt === 'string' ? { generatedAt: rec.generatedAt } : {};
}
