// scan.ts —— POST /v1/scan/promise：承诺·伏笔窄域补账扫描管线（4.2 薄切片批）。
//
// 分工（reference/05 §扫描器分工）：domain promise_prefilter 确定性预筛先行（嫌疑章/句/账本关联），
// 本管线只对预筛命中章做 LLM 原子声明抽取与判定（new/retire），操作序列映射在本层确定性完成
// （id 生成/目标键/证据锚不交给模型），提案草稿经 MCP inbox_append 入收件箱——作者裁决在收件箱，
// 本管线不落账。触发=批量（连载间隙），不在写作热路径；模型用便宜档（提案必经裁决，成本优先）。
// 质量纪律：噪音预期 F1≈0.68（外-b2）——裁决层收窄是设计内一环，管线宁多勿漏；
// 已登记承诺的普通呼应（link 类）不产提案（账本已有，静默合规）；未登记候选照常送判（超域规约）。
import { generateText, JSONParseError, NoObjectGeneratedError, NoOutputGeneratedError, Output, TypeValidationError, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import { getLlmTimeoutSeconds, type Tier } from './config.js';
import { HttpError, writeJson } from './http.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const scanBodySchema = z.object({
  workDir: z.string().min(1),
  chapterRelPaths: z.array(z.string()).max(50).optional(),
  /** 单次扫描最多送 LLM 的嫌疑章数（预算闸；预筛命中按序取前 N）。 */
  maxChapters: z.number().int().min(1).max(100).optional(),
});
export type ScanBody = z.infer<typeof scanBodySchema>;

export interface ScanDeps {
  modelForTier: (tier: Tier) => LanguageModel;
  tools: ToolSet | undefined;
  toolsAvailable?: () => boolean;
}

const scanFindingSchema = z.object({
  // link=已登记承诺的普通呼应：schema 收下后在映射层静默过滤（schema 硬拒会把整章判定炸掉）
  kind: z.enum(['new', 'retire', 'link']),
  /** retire 必填：判撤的已登记承诺 id。 */
  promiseId: z.string().optional(),
  /** new 必填：承诺/伏笔一句话（跨章需要记住的事实）。 */
  name: z.string().optional(),
  quote: z.string().min(1),
  rationale: z.string().min(1),
});
const scanFindingsSchema = z.object({ findings: z.array(scanFindingSchema).max(20) });
type ScanFinding = z.infer<typeof scanFindingSchema>;

/** 提案操作草稿（ProposalOp 形状的纯 JSON，域侧 makeProposal 接收）。 */
interface OpDraft {
  action: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
  op: Record<string, unknown>;
  targetKey: string;
  evidence: { chapter: string; quote?: string };
  rationale: string;
}

/** MCP 工具调用通用（review.ts 同模式；重连/缺工具 503，执行失败 502）。 */
async function callTool(deps: ScanDeps, name: string, args: Record<string, unknown>, abort: AbortSignal): Promise<unknown> {
  if (deps.toolsAvailable && !deps.toolsAvailable()) {
    throw new HttpError(503, `${name} 工具暂不可用（domain MCP 重连中，请稍后重试）`);
  }
  const tool = deps.tools?.[name];
  if (!tool?.execute) {
    throw new HttpError(503, `${name} 工具不可用（domain MCP 未连接或工具不存在）`);
  }
  const result: unknown = await tool.execute(args as never, { toolCallId: `scan-${name}`, messages: [], context: undefined, abortSignal: abort });
  if (result && typeof result === 'object') {
    const r = result as { isError?: unknown; structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> };
    const text = r.content?.find((c) => c && c.type === 'text' && typeof c.text === 'string')?.text;
    if (r.isError) throw new HttpError(502, `${name} 执行失败：${text ?? '未知错误'}`);
    if (r.structuredContent !== undefined) return r.structuredContent;
    if (text !== undefined) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return result;
}

const SYSTEM =
  '你是网文连续性台账的承诺·伏笔审计员。给定章节嫌疑句（确定性预筛产出）与已登记承诺清单，逐条判定：\n' +
  '- new：正文出现明确的承诺/约定/誓言/欠偿，且清单中没有对应登记（跨章需要记住的新事实）；\n' +
  '- retire：清单中某承诺在本章被明确作废（仅在正文有明确依据时给，promiseId 填清单 id）；\n' +
  '- 已登记承诺的普通呼应（link 类）不输出。\n' +
  'quote 必须逐字摘抄嫌疑句正文；rationale 一句话说明跨章意义。宁缺毋滥：拿不准不输出。';

/** 章键：取 relPath 末段数字（章号）补零 4 位——卷号等前段数字不并入（修复跨章碰撞）；无数字=0000。 */
export function chapterKeyOf(relPath: string): string {
  const groups = relPath.match(/\d+/g);
  return (groups?.[groups.length - 1] ?? '').padStart(4, '0').slice(-4) || '0000';
}

/** 承诺名稳定散列（djb2 base36 取 6 位）：id 不随 LLM 输出顺序漂移，跨次扫描同键可去重/抑制。 */
export function nameHash(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(6, '0').slice(-6);
}

/** LLM 判定 → 提案操作的确定性映射（id 生成/证据锚截断在本层定死）。 */
export function makeScanOps(chapter: string, chapterKey: string, findings: ScanFinding[]): OpDraft[] {
  const ops: OpDraft[] = [];
  for (const f of findings) {
    const quote = f.quote.slice(0, 80);
    if (f.kind === 'new' && f.name?.trim()) {
      const id = `P-S-${chapterKey}-${nameHash(f.name.trim())}`;
      ops.push({
        action: 'ADD',
        op: { op: 'promise', entry: { id, name: f.name.trim(), arc: 'planted', setups: [{ chapter, quote }], payoffs: [] } },
        targetKey: id,
        evidence: { chapter, quote },
        rationale: f.rationale,
      });
    } else if (f.kind === 'retire' && f.promiseId?.trim()) {
      const id = f.promiseId.trim();
      ops.push({
        action: 'DELETE',
        op: { op: 'remove', dimension: 'promise', id },
        targetKey: id,
        evidence: { chapter, quote },
        rationale: f.rationale,
      });
    }
  }
  return ops;
}

/** LLM 判定失败归类（对齐 review.ts 口径）：结构化输出失败给稳定中文消息，其余透传原始消息。 */
function classifyLlmError(err: unknown): string {
  if (NoObjectGeneratedError.isInstance(err) || NoOutputGeneratedError.isInstance(err) || JSONParseError.isInstance(err) || TypeValidationError.isInstance(err)) {
    return '模型输出不是合法 findings JSON（结构化校验失败）';
  }
  return err instanceof Error ? err.message : String(err);
}

/** 处理一次 /v1/scan/promise 请求。body 校验失败 400；工具不可用 503；模型/工具失败 502。 */
export async function handleScanRequest(body: unknown, deps: ScanDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = scanBodySchema.safeParse(body);
  if (!parsed.success) {
    writeJson(res, 400, { error: '请求体不合法: ' + parsed.error.issues.map((i) => i.message).join('; ') }, req.headers.origin);
    return;
  }
  const { workDir, chapterRelPaths, maxChapters } = parsed.data;

  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.on('close', onClose);

  try {
    // 第一步：确定性预筛（零 LLM）
    const pre = (await callTool(deps, 'promise_prefilter', { workDir, ...(chapterRelPaths ? { chapterRelPaths } : {}) }, abort.signal)) as {
      chapters?: Array<{ chapterRelPath: string; hits: Array<{ line: number; quote: string; predicate: string; matchedPromiseIds: string[] }> }>;
      registeredPromises?: number;
      scanned?: number;
    };
    const allSuspects = pre.chapters ?? [];
    const suspectChapters = allSuspects.slice(0, maxChapters ?? 20);
    const knownIds = [...new Set(allSuspects.flatMap((c) => c.hits.flatMap((h) => h.matchedPromiseIds)))];

    // 第二步：逐嫌疑章 LLM 判定（便宜档；零嫌疑不取模型）。单章失败记入 errors 继续批（修复前全批原子）；
    // 每章独立超时死线（修复前全批共享一条）；客户端断连即停烧 LLM（已产草稿仍入箱）。
    const detail: Array<{ chapter: string; proposalId: string; findings: ScanFinding[] }> = [];
    const errors: Array<{ chapter: string; error: string }> = [];
    let llmCalls = 0;
    const drafts: Array<{ origin: 'scan'; ops: OpDraft[] }> = [];
    if (suspectChapters.length > 0) {
      // 便宜档=background（与章摘要同档）：提案必经作者裁决，发现层成本优先
      const model = deps.modelForTier('background');
      for (const ch of suspectChapters) {
        if (abort.signal.aborted) break;
        const digest = ch.hits
          .map((h) => `- 第${h.line}行「${h.quote}」（触发：${h.predicate}${h.matchedPromiseIds.length ? `；关联：${h.matchedPromiseIds.join(',')}` : '；无登记关联'}）`)
          .join('\n');
        const knownList = knownIds.length ? knownIds.map((id) => `- ${id}`).join('\n') : '（本章预筛未关联到已登记承诺）';
        const chapterTimeout = AbortSignal.timeout(getLlmTimeoutSeconds() * 1000);
        try {
          const result = await generateText({
            model,
            system: SYSTEM,
            prompt: `章节：${ch.chapterRelPath}\n\n【已登记承诺 id 清单】\n${knownList}\n\n【本章嫌疑句（确定性预筛产出）】\n${digest}\n\n逐条判定，输出 findings。`,
            output: Output.object({ schema: scanFindingsSchema }),
            abortSignal: AbortSignal.any([abort.signal, chapterTimeout]),
          });
          llmCalls++;
          const findings = result.output?.findings ?? [];
          const ops = makeScanOps(ch.chapterRelPath, chapterKeyOf(ch.chapterRelPath), findings);
          if (ops.length === 0) continue;
          // 章内去重（同一 promiseId 多次 retire / 重复 new 名）：targetKey 唯一
          const seen = new Set<string>();
          const uniqueOps = ops.filter((o) => (seen.has(`${o.action}:${o.targetKey}`) ? false : (seen.add(`${o.action}:${o.targetKey}`), true)));
          drafts.push({ origin: 'scan', ops: uniqueOps });
          detail.push({ chapter: ch.chapterRelPath, proposalId: `draft#${drafts.length}`, findings });
        } catch (err) {
          if (abort.signal.aborted) break; // 取消不算章失败
          errors.push({
            chapter: ch.chapterRelPath,
            error: chapterTimeout.aborted ? `本章判定超时（超过 ${getLlmTimeoutSeconds()} 秒）` : classifyLlmError(err),
          });
        }
      }
    }

    // 第三步：入收件箱（MCP inbox_append；域侧生成 id）
    let added: string[] = [];
    let skipped: string[] = [];
    if (drafts.length > 0) {
      const r = (await callTool(deps, 'inbox_append', { workDir, drafts }, abort.signal)) as {
        added?: string[];
        skipped?: string[];
        outcomes?: Array<{ id: string; added: boolean }>;
      };
      added = r.added ?? [];
      skipped = r.skipped ?? [];
      // outcomes 与草稿同序（domain 4.2.1+），detail 与草稿 1:1 → 按下标对齐（修复 skip 错位/死分支）
      r.outcomes?.forEach((o, i) => {
        const d = detail[i];
        if (d) d.proposalId = o.added ? o.id : `skipped:${d.proposalId}`;
      });
    }

    writeJson(
      res,
      200,
      {
        scannedChapters: pre.scanned ?? 0,
        suspectChapters: suspectChapters.length,
        llmCalls,
        errors,
        inbox: { added, skipped },
        detail,
        coverage: { scanned: pre.scanned ?? 0, suspect: suspectChapters.length, window: chapterRelPaths ?? 'all' },
      },
      req.headers.origin,
    );
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, `扫描失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    res.off('close', onClose);
  }
}
