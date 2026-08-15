/**
 * review.svelte.ts —— WS-17 壳内审阅出口（确定性档，零 LLM 成本）：
 * 一键跑全书 scan_quality（LAY 去AI味扫描）+ ledger_diagnostics（四维账本确定性诊断，
 * 含问题日志 BLOCKER 计数），解析成逐章报告；BLOCKER 总数供顶栏入口红点徽标（清零出口：
 * 作者处理完重跑，徽标消失）。贵档 ledger_slice 不在此出口（后续单独做）。
 * 壳不 import domain：返回形状以 JSON 契约为准，这里镜像类型。
 */
import type { CoreClient, ReviewFinding } from './core.js';
import { work } from './work.svelte.js';

// ---------- domain 返回形状镜像（契约以 JSON 为准） ----------

export interface ScanHit {
  line: number;
  text: string;
}

export type ScanSeverity = 'pass' | 'warn' | 'fail' | 'info';

export interface ScanMetric {
  key: string;
  label: string;
  standard: string;
  count: number;
  severity: ScanSeverity;
  hits: ScanHit[];
  more?: number;
}

export interface ChapterScan {
  relPath: string;
  title: string;
  metrics: ScanMetric[];
}

export interface SceneContinuityViolation {
  scene: string;
  chapters: string[];
}

export interface TemplateParagraph {
  opening: string;
  chapters: string[];
}

export interface BookScan {
  scenePool: string[];
  sceneContinuity: SceneContinuityViolation[];
  templateParagraphs: TemplateParagraph[];
}

export interface WorkScanResult {
  workDir: string;
  chapters: ChapterScan[];
  book: BookScan;
}

export type FindingSeverity = 'BLOCKER' | 'MAJOR' | 'MODERATE' | 'MINOR';

/** 贵档冷读发现（core /v1/review 契约镜像）。 */
export type PremiumFinding = ReviewFinding;

export interface LedgerFinding {
  code: string;
  chapter?: string;
  severity: FindingSeverity;
  category: string;
  message: string;
}

export interface WorkDiagnostics {
  workDir: string;
  findings: LedgerFinding[];
  hasBlockers: boolean;
  /** 问题日志（CR 格式）里 `| BLOCKER |` 条数；日志缺失为 0。 */
  blockerCount: number;
}

// ---------- 报告模型（纯函数解析，可独立测试） ----------

/** 逐章行：扫描超标项（warn/fail）+ 该章诊断条目。 */
export interface ChapterReviewRow {
  relPath: string;
  title: string;
  metrics: ScanMetric[];
  findings: LedgerFinding[];
  /** 贵档冷读发现（与确定性诊断分区展示）。 */
  premium: PremiumFinding[];
}

export type SeverityCounts = Record<FindingSeverity, number>;

export interface ReviewReport {
  chapters: ChapterReviewRow[];
  /** 账本级（无章定位）诊断条目。 */
  bookFindings: LedgerFinding[];
  book: BookScan;
  /** 诊断条目按严重级计数。 */
  counts: SeverityCounts;
  /** 扫描超标项计数（逐章求和）。 */
  scanFail: number;
  scanWarn: number;
  /** 问题日志 BLOCKER 条数（domain blockerCount 原样透传）。 */
  issueLogBlockers: number;
  /** 红点徽标数：BLOCKER 诊断条目 + 问题日志 BLOCKER 条数。 */
  blockerTotal: number;
  hasBlockers: boolean;
  /** 干净态：无超标指标、无诊断条目、无书级违规。 */
  clean: boolean;
  ranAt: number;
}

/** 场景轮换池建议下限（对齐 domain qualityScan SCENE_POOL_MIN，仅展示用）。 */
export const SCENE_POOL_MIN = 5;

/** 扫描指标是否超标（pass/info 不算）。 */
export function isExceeded(m: ScanMetric): boolean {
  return m.severity === 'warn' || m.severity === 'fail';
}

/** 把 scan_quality + ledger_diagnostics 的原始结果解析成逐章报告。 */
export function buildReviewReport(scan: WorkScanResult, diag: WorkDiagnostics): ReviewReport {
  const counts: SeverityCounts = { BLOCKER: 0, MAJOR: 0, MODERATE: 0, MINOR: 0 };
  const byChapter = new Map<string, LedgerFinding[]>();
  const bookFindings: LedgerFinding[] = [];
  for (const f of diag.findings ?? []) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    if (f.chapter) {
      const arr = byChapter.get(f.chapter) ?? [];
      arr.push(f);
      byChapter.set(f.chapter, arr);
    } else {
      bookFindings.push(f);
    }
  }
  let scanFail = 0;
  let scanWarn = 0;
  const chapters: ChapterReviewRow[] = (scan.chapters ?? []).map((c) => {
    const metrics = (c.metrics ?? []).filter(isExceeded);
    for (const m of metrics) {
      if (m.severity === 'fail') scanFail += 1;
      else scanWarn += 1;
    }
    return { relPath: c.relPath, title: c.title, metrics, findings: byChapter.get(c.relPath) ?? [], premium: [] };
  });
  const book = scan.book ?? { scenePool: [], sceneContinuity: [], templateParagraphs: [] };
  const blockerTotal = counts.BLOCKER + (diag.blockerCount ?? 0);
  const clean =
    chapters.every((r) => r.metrics.length === 0 && r.findings.length === 0) &&
    bookFindings.length === 0 &&
    book.sceneContinuity.length === 0 &&
    book.templateParagraphs.length === 0;
  return {
    chapters,
    bookFindings,
    book,
    counts,
    scanFail,
    scanWarn,
    issueLogBlockers: diag.blockerCount ?? 0,
    blockerTotal,
    hasBlockers: diag.hasBlockers || blockerTotal > 0,
    clean,
    ranAt: Date.now(),
  };
}

function chapterTitleFromRelPath(relPath: string): string {
  return relPath.split(/[\\/]/).pop()?.replace(/\.md$/, '') ?? relPath;
}

function emptySeverityCounts(): SeverityCounts {
  return { BLOCKER: 0, MAJOR: 0, MODERATE: 0, MINOR: 0 };
}

/** 空报告：仅用于「不先跑便宜档、直接贵档审阅当前章」的底座；clean 恒为 false，避免把单章结果当全书结论。 */
export function emptyReviewReport(): ReviewReport {
  return {
    chapters: [],
    bookFindings: [],
    book: { scenePool: [], sceneContinuity: [], templateParagraphs: [] },
    counts: emptySeverityCounts(),
    scanFail: 0,
    scanWarn: 0,
    issueLogBlockers: 0,
    blockerTotal: 0,
    hasBlockers: false,
    clean: false,
    ranAt: Date.now(),
  };
}

/**
 * 把贵档发现按章合并进报告：确定性诊断计数 + 贵档计数一起进 counts/blockerTotal；
 * 贵档章不在报告章列表时（未跑便宜档或结构树尚未包含）补一章行单独展示。
 */
export function applyPremiumFindings(
  report: ReviewReport,
  premiumByChapter: ReadonlyMap<string, PremiumFinding[]>,
): ReviewReport {
  const counts = emptySeverityCounts();
  for (const f of report.bookFindings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  const remaining = new Map(premiumByChapter);
  const chapters = report.chapters.map((c) => {
    for (const f of c.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    const premium = remaining.get(c.relPath) ?? [];
    for (const f of premium) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    remaining.delete(c.relPath);
    return { ...c, premium };
  });

  for (const [relPath, premium] of remaining) {
    for (const f of premium) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    chapters.push({ relPath, title: chapterTitleFromRelPath(relPath), metrics: [], findings: [], premium });
  }

  const hasPremium = chapters.some((c) => c.premium.length > 0);
  const blockerTotal = counts.BLOCKER + (report.issueLogBlockers ?? 0);
  return {
    ...report,
    chapters,
    counts,
    blockerTotal,
    hasBlockers: report.hasBlockers || blockerTotal > 0,
    clean: report.clean && !hasPremium,
    ranAt: Date.now(),
  };
}

// ---------- store ----------

/** 问题日志约定路径（CR 格式 BLOCKER 计数；缺失时 domain 计 0，不报错）。 */
export const ISSUE_LOG_PATH = 'editorial_notes/issues.md';

export class ReviewStore {
  /** 审阅视图（全览覆盖层）开合。 */
  open = $state(false);
  running = $state(false);
  report = $state<ReviewReport | null>(null);
  /** 面板内嵌错误（反馈#4：失败不进 console / 不只在面板外红条，面板内红字可见；下次跑自动清）。 */
  error = $state<string | null>(null);
  /** 当前在跑的档位（反馈#4 进度文案区分）：scan=全书扫描，premium=贵档冷读。 */
  mode = $state<'scan' | 'premium'>('scan');
  /** 红点徽标数：关掉视图后仍保留（清零出口：处理完重跑即消失）。 */
  blockerTotal = $derived(this.report?.blockerTotal ?? 0);
  hasBlockers = $derived(this.report?.hasBlockers ?? false);

  private client!: CoreClient;
  private workDir = '';
  /** 贵档发现按章缓存：重跑便宜档后仍合并保留。 */
  private premium = new Map<string, PremiumFinding[]>();

  init(client: CoreClient, workDir: string): void {
    this.client = client;
    this.workDir = workDir;
  }

  /** 顶栏入口：开视图并跑一轮扫描；已开则关（结果保留，徽标不丢）。 */
  async toggle(): Promise<void> {
    if (this.open) {
      this.open = false;
      return;
    }
    this.open = true;
    await this.run();
  }

  close(): void {
    this.open = false;
  }

  /** 跑全书扫描 + 账本诊断；失败在面板内嵌红字 + work.error 红条，不吞错。 */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.error = null;
    this.mode = 'scan';
    try {
      const [scan, diag] = await Promise.all([
        this.client.callTool<WorkScanResult>('scan_quality', { workDir: this.workDir }),
        this.client.callTool<WorkDiagnostics>('ledger_diagnostics', {
          workDir: this.workDir,
          issueLogPath: ISSUE_LOG_PATH,
        }),
      ]);
      this.report = applyPremiumFindings(buildReviewReport(scan, diag), this.premium);
    } catch (err) {
      const msg = `审阅扫描失败：${err instanceof Error ? err.message : String(err)}`;
      this.error = msg;
      work.error = msg;
    } finally {
      this.running = false;
    }
  }

  /**
   * 贵档审阅当前章：调 core /v1/review（ledger_slice + main 档模型），把 findings 合并进报告。
   * 允许不先跑便宜档：无确定性报告时用空报告底座单独展示贵档结果。
   */
  async runPremium(chapterRelPath: string): Promise<void> {
    if (this.running) return;
    if (!chapterRelPath) {
      work.error = '请先打开一个章节';
      return;
    }
    this.running = true;
    this.error = null;
    this.mode = 'premium';
    try {
      const { findings } = await this.client.review(this.workDir, chapterRelPath);
      this.premium.set(chapterRelPath, findings);
      this.report = applyPremiumFindings(this.report ?? emptyReviewReport(), this.premium);
    } catch (err) {
      const msg = `贵档审阅失败：${err instanceof Error ? err.message : String(err)}`;
      this.error = msg;
      work.error = msg;
    } finally {
      this.running = false;
    }
  }

  dismissError(): void {
    this.error = null;
  }
}

export const review = new ReviewStore();
