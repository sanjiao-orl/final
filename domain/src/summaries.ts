/**
 * summaries.ts —— 章摘要导生缓存 + 节奏诊断。
 *
 * 导生缓存纪律（决策 0011/0013）：章摘要是「正文 → AI 生成」的预处理产物，可焚可重建——
 * 缓存文件损坏即焚毁重建，不做快照、不做修复；缓存永远不是事实源，正文才是。
 * 存储为单个 JSON 文件 `.novel/cache/chapter-summaries.json`，结构
 * `{ version: 1, chapters: { [relPath]: ChapterSummaryRecord } }`。
 *
 * 冻结语义（决策 0013 决策4 原文语义）：机检字段 tension/sceneType/wordCount 随缓存
 * 「首次落盘」即冻结——重建（再次生成）只回改 summary 散文与 generatedAt，不回改机检字段，
 * 防止重建漂移污染历史数据。机检字段只在旧记录缺该字段时写入。
 *
 * 依赖方向：summaries → ledger 单向（仅 import LedgerFinding 类型供 pacingDiagnostics 复用）；
 * ledger 不 import 本文件，禁止反向依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertWorkDir, atomicWrite, toPosix } from './fsutil.js';
import { chapterOrderForWork, type LedgerFinding } from './ledger.js';

/** 单章摘要缓存记录。 */
export interface ChapterSummaryRecord {
  /** 摘要散文（AI 生成，重建可改）。 */
  summary: string;
  /** 张力 1-10（机检字段，首写冻结）。 */
  tension?: number;
  /** 场景类型（机检字段，首写冻结）：战斗/日常/过渡/高潮/悬念/情感/其他。 */
  sceneType?: string;
  /** 字数（机检字段，首写冻结；非空白字符口径=tools.countWords）。 */
  wordCount?: number;
  /** 摘要散文生成时间（ISO；重建时更新）。 */
  generatedAt: string;
}

export interface ChapterSummaryView extends ChapterSummaryRecord {
  relPath: string;
  /** 章已不在当前章序（被删/改名）→ true（缺省不出现=false 语义）。 */
  stale?: boolean;
}

/** 缓存文件落盘结构。 */
interface SummaryCacheFile {
  version: 1;
  chapters: Record<string, ChapterSummaryRecord>;
}

const CACHE_REL = toPosix(path.join('.novel', 'cache', 'chapter-summaries.json'));

function cacheAbs(workDir: string): string {
  return path.join(assertWorkDir(workDir), '.novel', 'cache', 'chapter-summaries.json');
}

function emptyCache(): SummaryCacheFile {
  return { version: 1, chapters: {} };
}

/**
 * 读导生缓存：文件不存在/损坏 → 空缓存（导生纪律：可焚可重建，损坏不抛错，
 * console.warn 留痕即可）。调用方拿到的永远是合法结构。
 */
function loadCache(workDir: string): SummaryCacheFile {
  let raw: string;
  try {
    raw = fs.readFileSync(cacheAbs(workDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyCache();
    throw err; // 非 ENOENT 的读取故障照常上抛（权限等需人工介入）
  }
  try {
    const parsed = JSON.parse(raw) as SummaryCacheFile;
    if (parsed.version !== 1 || typeof parsed.chapters !== 'object' || parsed.chapters === null) {
      throw new Error('结构不符');
    }
    return parsed;
  } catch (err) {
    console.warn(`[summaries] 章摘要缓存已损坏，按空缓存处理（可焚可重建）: ${CACHE_REL}（${err instanceof Error ? err.message : String(err)}）`);
    return emptyCache();
  }
}

/**
 * 读章摘要视图：
 * - relPath 给了 → 只返回该章（不在缓存 → 空数组）；
 * - opts.before（章 relPath）给了 → 返回章序中该章之前最近一章有摘要的记录（0 或 1 条，
 *   供「前章摘要」注入；before 不在章序内 → 空数组）；
 * - 都不给 → 返回全部，按 chapterOrderForWork 章序排；
 *   不在章序的（被删/改名）stale:true 排最后，彼此间按 relPath 字典序兜底。
 */
export function readChapterSummaries(
  workDir: string,
  relPath?: string,
  opts?: { before?: string },
): { summaries: ChapterSummaryView[] } {
  const cache = loadCache(workDir);
  if (opts?.before !== undefined) {
    const order = chapterOrderForWork(workDir);
    const idx = order.findIndex((c) => c.relPath === toPosix(opts.before!));
    if (idx <= 0) return { summaries: [] };
    for (let i = idx - 1; i >= 0; i--) {
      const rec = cache.chapters[order[i]!.relPath];
      if (rec) return { summaries: [{ ...rec, relPath: order[i]!.relPath }] };
    }
    return { summaries: [] };
  }
  if (relPath !== undefined) {
    const rec = cache.chapters[toPosix(relPath)];
    return { summaries: rec ? [{ ...rec, relPath: toPosix(relPath) }] : [] };
  }
  const order = chapterOrderForWork(workDir);
  const inOrder = new Map(order.map((c) => [c.relPath, c] as const));
  const views: ChapterSummaryView[] = [];
  for (const c of order) {
    const rec = cache.chapters[c.relPath];
    if (rec) views.push({ ...rec, relPath: c.relPath });
  }
  // 不在章序的 stale 章：排最后，relPath 字典序兜底
  const stale = Object.entries(cache.chapters)
    .filter(([rp]) => !inOrder.has(rp))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([rp, rec]) => ({ ...rec, relPath: rp, stale: true as const }));
  return { summaries: [...views, ...stale] };
}

/**
 * 写单章摘要（read-modify-write 整个缓存 JSON，atomicWrite 原子落盘）：
 * - 校验：relPath 必须在 chapterOrderForWork 内（防给不存在的章写缓存）；summary 非空字符串；
 *   tension 若给必须是 1-10 整数；sceneType 若给必须是非空字符串（不枚举校验，
 *   LLM 输出容错由调用方做）；wordCount 若给必须是 ≥0 整数。
 * - 冻结：已存在记录的 tension/sceneType/wordCount 只在「旧记录没有该字段」时写入
 *   （0013 决策4）；summary/generatedAt 总更新。
 * - frozen=true 表示「传入的机检字段中至少一项因旧值已存在而被冻结未更新」。
 * - 旧缓存文件损坏时由 loadCache 焚毁当空、本次写直接重建覆盖（写前不需要快照）。
 */
export function writeChapterSummary(
  workDir: string,
  relPath: string,
  record: { summary: string; tension?: number; sceneType?: string; wordCount?: number },
): { ok: true; frozen: boolean } {
  const wd = assertWorkDir(workDir);
  const rp = toPosix(relPath);
  if (!chapterOrderForWork(wd).some((c) => c.relPath === rp)) {
    throw new Error(`章不在当前章序内，拒绝写摘要缓存: ${rp}`);
  }
  if (typeof record.summary !== 'string' || record.summary.trim() === '') {
    throw new Error(`summary 必须是非空字符串: ${rp}`);
  }
  if (record.tension !== undefined && (!Number.isInteger(record.tension) || record.tension < 1 || record.tension > 10)) {
    throw new Error(`tension 必须是 1-10 的整数: ${String(record.tension)}（${rp}）`);
  }
  if (record.sceneType !== undefined && (typeof record.sceneType !== 'string' || record.sceneType.trim() === '')) {
    throw new Error(`sceneType 必须是非空字符串: ${rp}`);
  }
  if (record.wordCount !== undefined && (!Number.isInteger(record.wordCount) || record.wordCount < 0)) {
    throw new Error(`wordCount 必须是 ≥0 的整数: ${String(record.wordCount)}（${rp}）`);
  }

  const cache = loadCache(wd);
  const old = cache.chapters[rp];
  let frozen = false;
  const next: ChapterSummaryRecord = {
    summary: record.summary,
    generatedAt: new Date().toISOString(),
  };
  // 机检字段：只在旧记录没有该字段时写入（首写冻结，重建不回改）
  if (old?.tension !== undefined) {
    next.tension = old.tension; // 保持旧值
    if (record.tension !== undefined) frozen = true; // 传了新值但被冻结
  } else if (record.tension !== undefined) {
    next.tension = record.tension; // 首写
  }
  if (old?.sceneType !== undefined) {
    next.sceneType = old.sceneType;
    if (record.sceneType !== undefined) frozen = true;
  } else if (record.sceneType !== undefined) {
    next.sceneType = record.sceneType;
  }
  if (old?.wordCount !== undefined) {
    next.wordCount = old.wordCount;
    if (record.wordCount !== undefined) frozen = true;
  } else if (record.wordCount !== undefined) {
    next.wordCount = record.wordCount;
  }
  cache.chapters[rp] = next;
  atomicWrite(cacheAbs(wd), `${JSON.stringify(cache, null, 2)}\n`);
  return { ok: true, frozen };
}

/**
 * 节奏诊断（纯函数+读缓存）：供 ledger_diagnostics 合并，确定性规则、永不产 BLOCKER。
 * 唯一一条规则（宁缺毋滥）：按章序取「在章序内且有 tension」的章成序列，
 * 序列尾部连续 ≥5 章 tension ≤4 → 一条 `pacing-flat`（MODERATE/PACE）。
 * 序列 <5 章或尾部连续 <5 → 空数组；读缓存失败 → 空数组（诊断永不因缓存故障炸掉主链路）。
 */
export function pacingDiagnostics(workDir: string): LedgerFinding[] {
  let summaries: ChapterSummaryView[];
  try {
    summaries = readChapterSummaries(workDir).summaries.filter((s) => !s.stale);
  } catch (err) {
    console.warn(`[summaries] 读摘要缓存失败，节奏诊断跳过（${err instanceof Error ? err.message : String(err)}）`);
    return [];
  }
  // 只取在章序内的章按章序排（readChapterSummaries 已保证非 stale 段即章序）
  const seq = summaries.filter((s) => s.tension !== undefined);
  if (seq.length < 5) return [];
  // 尾部连续 tension ≤4 的段
  let runStart = seq.length;
  for (let i = seq.length - 1; i >= 0 && (seq[i]!.tension ?? 10) <= 4; i--) runStart = i;
  const runLen = seq.length - runStart;
  if (runLen < 5) return [];
  const first = seq[runStart]!;
  const titles = new Map(chapterOrderForWork(workDir).map((c) => [c.relPath, c.title] as const));
  return [
    {
      code: 'pacing-flat',
      chapter: first.relPath,
      severity: 'MODERATE',
      category: 'PACE',
      message: `节奏偏平：最近连续 ${runLen} 章张力 ≤4（自《${titles.get(first.relPath) ?? first.relPath}》起），考虑安排冲突/反转`,
    },
  ];
}
