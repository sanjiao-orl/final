// 模块职责：POST /v1/quality/check 的发布前质检管道（便宜模型路线，作者定调：不写大词表，
// LLM 查错别字/敏感词）——read_chapter 取章 → background 档 Output.array 结构化找问题 →
// **确定性定位**：LLM 只报 quote（逐字摘录），位置由代码 indexOf 定（line=文件行号、
// paraLine=所在段落段首行号）；quote 匹配不到 → located:false 正常降级不报错。
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

/** 质检输入正文上限：超长截断并在响应里标 truncated:true（便宜档上下文有限）。 */
export const QUALITY_BODY_MAX_CHARS = 12_000;

export interface QualityCheckDeps {
  /** background（便宜）档模型。 */
  modelForTier: (tier: Tier) => LanguageModel;
  /** MCP 领域工具注册表；read_chapter 从这里取。 */
  tools: ToolSet | undefined;
}

/** LLM 输出契约（与 prompts/quality-check.md 同口径）：只含问题本身，不含位置。 */
export const qualityFindingSchema = z.object({
  kind: z.enum(['typo', 'sensitive', 'wording', 'other']),
  quote: z.string(),
  reason: z.string(),
  suggestion: z.string().optional(),
});
export type QualityFindingRaw = z.infer<typeof qualityFindingSchema>;

/** 带确定性定位的 finding：located=false 时不出 line/paraLine（LLM 复述而非逐字摘录是正常降级路径）。 */
export interface QualityFinding extends QualityFindingRaw {
  /** quote 在正文里的 1 起始文件行号（含 frontmatter 行）。 */
  line?: number;
  /** 所在段落的段首行号（段落=正文按空行分组；文件行号口径）。 */
  paraLine?: number;
  located: boolean;
}

export interface QualityCheckResult {
  ok: true;
  chapterTitle: string;
  truncated?: boolean;
  findings: QualityFinding[];
}

/**
 * 发布前质检单章。链路：read_chapter → LLM 结构化查错 → 代码定位。
 * 工具缺失/失败/模型输出不合规抛 HttpError；quote 找不到不算错误。
 */
export async function qualityCheckChapter(
  deps: QualityCheckDeps,
  workDir: string,
  relPath: string,
  abortSignal?: AbortSignal
): Promise<QualityCheckResult> {
  // 1. 取章：content（全文，定位基准）+ body（拼提示词）+ frontmatter（章标题）
  const chapterRaw = await callDomainTool(deps.tools, 'read_chapter', { workDir, relPath }, {
    toolCallId: 'quality-read-chapter',
    ...(abortSignal ? { abortSignal } : {}),
  });
  const chapter = unwrapToolPayload(chapterRaw);
  const { content, body, title } = readChapterFields(chapter);

  // 2. background 档一次性结构化输出（Output.array，仿 review.ts）
  const truncated = body.length > QUALITY_BODY_MAX_CHARS;
  const bodyText = truncated ? body.slice(0, QUALITY_BODY_MAX_CHARS) + `\n…（正文超 ${QUALITY_BODY_MAX_CHARS} 字已截断）` : body;
  const timeoutSeconds = getLlmTimeoutSeconds();
  const timeoutSignal = AbortSignal.timeout(timeoutSeconds * 1000);
  let findings: QualityFindingRaw[];
  try {
    const result = await generateText({
      model: deps.modelForTier('background'),
      system: loadPrompt('quality_check'),
      prompt: `【章标题】${title || relPath}\n【正文】\n${bodyText}`,
      output: Output.array({ element: qualityFindingSchema }),
      abortSignal: AbortSignal.any([...(abortSignal ? [abortSignal] : []), timeoutSignal]),
    });
    findings = await result.output;
  } catch (err) {
    if (timeoutSignal.aborted && !abortSignal?.aborted) {
      throw new HttpError(504, `LLM 请求超时（超过 ${timeoutSeconds} 秒）`);
    }
    if (
      NoObjectGeneratedError.isInstance(err) ||
      NoOutputGeneratedError.isInstance(err) ||
      JSONParseError.isInstance(err) ||
      TypeValidationError.isInstance(err)
    ) {
      throw new HttpError(502, '模型输出不是合法的质检结果（需为 findings JSON 数组）');
    }
    throw err;
  }

  // 3. 确定性定位：LLM 只找问题，位置由代码定（quote 匹配不到 → located:false 降级）
  const offsetLines = frontmatterLineOffset(chapter);
  return {
    ok: true,
    chapterTitle: title || relPath,
    ...(truncated ? { truncated: true as const } : {}),
    findings: locateFindings(findings, content, body, offsetLines),
  };
}

/** 从 read_chapter 结果收窄 content/body/title：结构不符抛 502。 */
function readChapterFields(payload: unknown): { content: string; body: string; title: string } {
  if (!payload || typeof payload !== 'object') throw new HttpError(502, 'read_chapter 工具返回结果无效');
  const p = payload as { content?: unknown; body?: unknown; frontmatter?: unknown };
  if (typeof p.content !== 'string' || typeof p.body !== 'string') {
    throw new HttpError(502, 'read_chapter 工具返回结果无效（缺 content/body）');
  }
  const fm = p.frontmatter;
  const title =
    fm && typeof fm === 'object' && typeof (fm as { title?: unknown }).title === 'string'
      ? (fm as { title: string }).title
      : '';
  return { content: p.content, body: p.body, title };
}

/** body 在全文中的行偏移 = frontmatterRaw 的行数（frontmatterRaw 以换行结尾，split 尾部多一个空片段，减 1）。 */
function frontmatterLineOffset(payload: unknown): number {
  if (!payload || typeof payload !== 'object') return 0;
  const raw = (payload as { frontmatterRaw?: unknown }).frontmatterRaw;
  if (typeof raw !== 'string' || raw === '') return 0;
  return raw.split(/\r?\n/).length - 1;
}

/**
 * 对每条 finding 做 indexOf 定位：
 * - quote 先 trim 并剥成对引号（「」『』“”‘’"'）再匹配——LLM 可能带引号复述；
 * - line = 全文中首现位置的 1 起始文件行号（content.slice(0, idx) 按换行切数行数）；
 * - 精确 indexOf 未中 → 紧凑兜底（D7「跨行 quote 定位必失配」）：双侧剥全部空白
 *   （\s 含 \u00a0/\u3000，换行一并剥去）后在整文紧凑串里找首现——LLM 复述的跨行 quote
 *   与 CRLF/LF、段间空行差异在此命中，返回首字符所在文件行号；
 * - paraLine = 所在段落的段首行号（正文按空行分组，段首行=该段第一行的文件行号；
 *   body 与 content 的行号偏移 = frontmatter 行数）；
 * - 两过都找不到 → located:false，line/paraLine 不出。
 */
function locateFindings(findings: QualityFindingRaw[], content: string, body: string, offsetLines: number): QualityFinding[] {
  const bodyLines = body.split(/\r?\n/);
  // 紧凑索引按需构建一次（有 finding 精确未中才建）：紧凑串剥全部空白，lineOf 同长记录每个紧凑字符的文件行号。
  let compact: { text: string; lineOf: number[] } | undefined;
  const compactIndex = (): { text: string; lineOf: number[] } => {
    if (compact) return compact;
    const chars: string[] = [];
    const lineOf: number[] = [];
    let line = 1;
    for (const ch of content) {
      if (ch === '\n') {
        line += 1;
        continue;
      }
      if (/\s/.test(ch)) continue;
      chars.push(ch);
      lineOf.push(line);
    }
    compact = { text: chars.join(''), lineOf };
    return compact;
  };
  return findings.map((f) => {
    const needle = f.quote.trim().replace(/^[「『“'"']+/, '').replace(/[」』”'"']+$/, '').trim();
    if (needle === '') return { ...f, located: false };
    const idx = content.indexOf(needle);
    let line: number;
    if (idx >= 0) {
      line = content.slice(0, idx).split(/\r?\n/).length;
    } else {
      const compactNeedle = needle.replace(/\s/g, '');
      if (compactNeedle === '') return { ...f, located: false };
      const ci = compactIndex();
      const compactIdx = ci.text.indexOf(compactNeedle);
      if (compactIdx < 0) return { ...f, located: false };
      line = ci.lineOf[compactIdx]!;
    }
    const paraLine = paragraphStartLine(bodyLines, line - offsetLines, offsetLines);
    return { ...f, located: true, line, paraLine };
  });
}

/**
 * 正文内第 relLine 行（1 起始）所在段落的段首行号（正文相对），换算回文件行号返回。
 * 段落边界：空行之后的首个非空行开启新段。relLine 落在正文范围外（如 quote 出现在 frontmatter 区）
 * 时按 clamp 到第 1 段处理。
 */
function paragraphStartLine(bodyLines: string[], relLine: number, offsetLines: number): number {
  const clamped = Math.max(1, Math.min(relLine, Math.max(bodyLines.length, 1)));
  let start = 1;
  for (let i = 2; i <= clamped; i++) {
    const prevBlank = (bodyLines[i - 2] ?? '').trim() === '';
    const curNonBlank = (bodyLines[i - 1] ?? '').trim() !== '';
    if (prevBlank && curNonBlank) start = i;
  }
  return start + offsetLines;
}
