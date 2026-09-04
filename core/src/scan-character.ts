// scan-character.ts —— POST /v1/scan/character：角色维确定性补账（4.3 角色卡批；零 LLM）。
//
// 分工（reference/05 §角色维+超域处置规约）：domain character_prefilter 确定性预筛先行（已知名/别名提及、
// 超域疑似、同一人多写法），本管线只做确定性映射与入箱，不落账：
// - 超域疑似（高频未命中候选）→ ADD character 草稿（作者在收件箱裁决去留——不静默丢弃）；
// - 同一人多写法嫌疑 → NOOP 观察提案（作者裁决是否登记为别名；采纳=记录观察，不落账实体）。
// 预算闸 maxCandidates（缺省 20）防一次性灌爆收件箱；触发=批量（连载间隙），不在写作热路径。
import { z } from 'zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, writeJson } from './http.js';
import { callTool } from './scan.js';

export const scanCharacterBodySchema = z.object({
  workDir: z.string().min(1),
  chapterRelPaths: z.array(z.string()).max(50).optional(),
  /** 单次最多入箱的草稿数（预算闸；超域疑似优先，余量给写法变体）。 */
  maxCandidates: z.number().int().min(1).max(50).optional(),
});
export type ScanCharacterBody = z.infer<typeof scanCharacterBodySchema>;

export interface ScanCharacterDeps {
  tools: import('ai').ToolSet | undefined;
  toolsAvailable?: () => boolean | undefined;
}

/** 处理一次 /v1/scan/character 请求。body 校验失败 400；工具不可用 503；工具执行失败 502。 */
export async function handleScanCharacterRequest(body: unknown, deps: ScanCharacterDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = scanCharacterBodySchema.safeParse(body);
  if (!parsed.success) {
    writeJson(res, 400, { error: '请求体不合法: ' + parsed.error.issues.map((i) => i.message).join('; ') }, req.headers.origin);
    return;
  }
  const { workDir, chapterRelPaths, maxCandidates } = parsed.data;

  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.on('close', onClose);

  try {
    // 第一步：确定性预筛（零 LLM）；角色维未启用（domain enabled:false）→ 零候选自然零入箱
    const pre = (await callTool(deps, 'character_prefilter', { workDir, ...(chapterRelPaths ? { chapterRelPaths } : {}) }, abort.signal)) as {
      enabled?: boolean;
      scanned?: number;
      mentions?: Array<{ name: string; count: number }>;
      unknownCandidates?: Array<{ name: string; count: number; firstChapter: string }>;
      variantSuspects?: Array<{ variant: string; likely: string; count: number }>;
    };
    const unknownCandidates = pre.unknownCandidates ?? [];
    const variantSuspects = pre.variantSuspects ?? [];
    const cap = maxCandidates ?? 20;

    // 第二步：确定性映射（id/目标键/摘由在本层定死）→ 提案草稿
    const drafts: Array<{ origin: 'scan'; ops: Array<Record<string, unknown>> }> = [];
    for (const c of unknownCandidates.slice(0, cap)) {
      drafts.push({
        origin: 'scan',
        ops: [
          {
            action: 'ADD',
            op: { op: 'character', entry: { name: c.name } },
            targetKey: c.name,
            evidence: { chapter: c.firstChapter },
            rationale: `超域疑似：「${c.name}」提及 ${c.count} 次未命中已知名/别名（作者裁决去留）`,
          },
        ],
      });
    }
    const variantCap = Math.max(0, cap - drafts.length);
    for (const v of variantSuspects.slice(0, variantCap)) {
      drafts.push({
        origin: 'scan',
        ops: [
          {
            action: 'NOOP',
            op: { op: 'character', entry: { name: v.likely } },
            // targetKey=具体变体（抑制键粒度=单条变体）：likely 名作键会让一次误报静默吞掉同名未来所有新变体
            targetKey: v.variant,
            rationale: `同一人多写法嫌疑：「${v.variant}」≈「${v.likely}」（编辑距离 1，出现 ${v.count} 次）——裁决是否登记为别名`,
          },
        ],
      });
    }

    // 第三步：入收件箱（MCP inbox_append；零草稿不调工具）
    let added: string[] = [];
    let skipped: string[] = [];
    const detail: Array<{ proposalId: string }> = drafts.map((d) => ({ proposalId: String((d.ops[0] as { targetKey: string }).targetKey) }));
    if (drafts.length > 0) {
      const r = (await callTool(deps, 'inbox_append', { workDir, drafts }, abort.signal)) as {
        added?: string[];
        skipped?: string[];
        outcomes?: Array<{ id: string; added: boolean }>;
      };
      added = r.added ?? [];
      skipped = r.skipped ?? [];
      // outcomes 与草稿同序（domain 4.2.1+）：回填真实提案 id（与 scan.ts 同纪律）
      r.outcomes?.forEach((o, i) => {
        if (detail[i]) detail[i]!.proposalId = o.added ? o.id : `skipped:${detail[i]!.proposalId}`;
      });
    }

    writeJson(
      res,
      200,
      {
        scannedChapters: pre.scanned ?? 0,
        knownMentions: (pre.mentions ?? []).length,
        unknownCandidates: unknownCandidates.length,
        variantSuspects: variantSuspects.length,
        inbox: { added, skipped },
        detail,
      },
      req.headers.origin,
    );
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, `角色补账扫描失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    res.off('close', onClose);
  }
}
