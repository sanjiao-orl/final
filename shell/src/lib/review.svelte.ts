/**
 * review.svelte.ts —— WS-17 壳内审阅出口（确定性档，零 LLM 成本）：
 * 一键跑全书 scan_quality（LAY 去AI味扫描）+ ledger_diagnostics（四维账本确定性诊断，
 * 含问题日志 BLOCKER 计数），解析成逐章报告；BLOCKER 总数供顶栏入口红点徽标（清零出口：
 * 作者处理完重跑，徽标消失）。贵档 ledger_slice 不在此出口（后续单独做）。
 * 处置闭环：贵档发现落盘后带 CR id，卡片上可标记「已处理/已知」（issue_set_status），
 * 成功后本地标灰并把该发现的 BLOCKER 从徽标计数中扣减。
 * R5：分级扫描（quick/standard/deep，见 REVIEW_LEVELS）+ 可取消（本地 AbortController 竞速 +
 * ac.signal 经 CoreClient RequestOptions 透传中止传输层；取消/失败都释放 running 锁）
 * + 部分成功可见（scan/diag 逐项结算，见 items）+ 可关后台（close 只收视图，跑完重开可查）。
 * 壳不 import domain：返回形状以 JSON 契约为准，这里镜像类型。
 */
import type { CoreClient, ReviewFinding } from './core.js';
import { scheme } from './scheme.svelte.js';
import { work } from './work.svelte.js';
import { ISSUE_LOG_DEFAULT } from './paths.js';

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

/**
 * 把 scan_quality + ledger_diagnostics 的原始结果解析成逐章报告。
 * 两段可分别缺省（部分成功可见：一段失败时用成功那段出报告）；任一缺省时 clean 恒 false——
 * 缺了确定性检查的一半，不能替作者下「干净」结论。
 */
export function buildReviewReport(scan: WorkScanResult | null, diag: WorkDiagnostics | null): ReviewReport {
  const counts: SeverityCounts = { BLOCKER: 0, MAJOR: 0, MODERATE: 0, MINOR: 0 };
  const byChapter = new Map<string, LedgerFinding[]>();
  const bookFindings: LedgerFinding[] = [];
  for (const f of diag?.findings ?? []) {
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
  const chapters: ChapterReviewRow[] = (scan?.chapters ?? []).map((c) => {
    const metrics = (c.metrics ?? []).filter(isExceeded);
    for (const m of metrics) {
      if (m.severity === 'fail') scanFail += 1;
      else scanWarn += 1;
    }
    return { relPath: c.relPath, title: c.title, metrics, findings: byChapter.get(c.relPath) ?? [], premium: [] };
  });
  const book = scan?.book ?? { scenePool: [], sceneContinuity: [], templateParagraphs: [] };
  const blockerTotal = counts.BLOCKER + (diag?.blockerCount ?? 0);
  const clean =
    scan !== null &&
    diag !== null &&
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
    issueLogBlockers: diag?.blockerCount ?? 0,
    blockerTotal,
    hasBlockers: (diag?.hasBlockers ?? false) || blockerTotal > 0,
    clean,
    ranAt: Date.now(),
  };
}

function chapterTitleFromRelPath(relPath: string): string {
  return relPath.split(/[\\/]/).pop()?.replace(/\.md$/, '') ?? relPath;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/** R5 分级扫描档位：快速=确定性指标；标准=指标+账本诊断（现状默认）；深度=标准+当前章贵档冷读。 */
export type ReviewLevel = 'quick' | 'standard' | 'deep';

/** 档位元数据（面板选择器渲染用）：名字 + 一句话说明（点之前知道会发生什么、贵不贵）。 */
export const REVIEW_LEVELS: ReadonlyArray<{ id: ReviewLevel; label: string; desc: string }> = [
  { id: 'quick', label: '快速', desc: '仅去AI味指标扫描，零 LLM 成本，最快' },
  { id: 'standard', label: '标准', desc: '指标扫描 + 账本确定性诊断，零 LLM 成本（默认）' },
  { id: 'deep', label: '深度', desc: '标准档全部检查 + 当前章贵档 LLM 冷读（按章计费）' },
];

/** 单项扫描的独立结果状态（部分成功可见）：ok/fail 带错误信息；skipped=该档位未包含此项。 */
export interface ScanItemState {
  status: 'ok' | 'fail' | 'skipped';
  error?: string;
}

/** 取消专用错误：AbortController 触发时注入 Promise 竞速；调用方据此静默收场（不进红条）。 */
export class ReviewCancelled extends Error {
  constructor() {
    super('审阅已取消');
    this.name = 'ReviewCancelled';
  }
}

/** 贵档审阅响应（core /v1/review 契约镜像 + persistedError 加法字段镜像）。 */
interface PremiumReviewResponse {
  findings: PremiumFinding[];
  persisted?: { appended: number; ids: string[] };
  persistedError?: string;
}

/**
 * 长任务调用超时：全书扫描/账本诊断是分钟级全量遍历，贵档冷读受 core 服务端 LLM 超时（600s）约束；
 * 取消走 signal，超时只是兜底——对齐 core 服务端 LLM 超时上限。
 */
const LONG_CALL_TIMEOUT_MS = 600_000;

/** 贵档发现的处置状态（issue_set_status 的 done/known，成功即本地标灰）。 */
export type FindingDisposal = 'done' | 'known';

export class ReviewStore {
  /** 审阅视图（全览覆盖层）开合。 */
  open = $state(false);
  running = $state(false);
  report = $state<ReviewReport | null>(null);
  /** 面板内嵌错误（反馈#4：失败不进 console / 不只在面板外红条，面板内红字可见；下次跑自动清）。 */
  error = $state<string | null>(null);
  /** 当前在跑的档位（反馈#4 进度文案区分）：scan=全书扫描，premium=贵档冷读。 */
  mode = $state<'scan' | 'premium'>('scan');
  /** R5 分级扫描档位：默认 standard 保持现状行为（指标 + 账本诊断）。 */
  level = $state<ReviewLevel>('standard');
  /**
   * 各扫描项最近一次运行的独立状态（部分成功可见）：新一次运行前重置为空；
   * fail 带错误信息，quick 档 diag 标 skipped。
   */
  items = $state<{ scan?: ScanItemState; diag?: ScanItemState }>({});
  /**
   * 贵档发现已返回但落盘失败的原因（core persistedError 镜像）：findings 可看，
   * 但作者要知道「没进问题日志、无法处置」。下次贵档跑前清。
   */
  persistError = $state<string | null>(null);
  /** 已处置的贵档发现（key=CR id → done/known）：处置成功后本地标灰，重跑保留。 */
  disposed = $state(new Map<string, FindingDisposal>());
  /** 本地已处置的 premium BLOCKER 条数（扣减 blockerTotal 用）。 */
  private disposedBlockerCount = $derived.by(() => {
    let n = 0;
    for (const [relPath, findings] of this.premium) {
      const ids = this.premiumIds.get(relPath);
      if (!ids) continue;
      findings.forEach((f, i) => {
        if (f.severity === 'BLOCKER' && ids[i] && this.disposed.has(ids[i]!)) n += 1;
      });
    }
    return n;
  });
  /** 红点徽标数：关掉视图后仍保留（清零出口：处理完重跑即消失）；本地已处置的 BLOCKER 扣减。 */
  blockerTotal = $derived((this.report?.blockerTotal ?? 0) - this.disposedBlockerCount);
  hasBlockers = $derived(this.report?.hasBlockers ?? false);

  private client!: CoreClient;
  private workDir = '';
  /** 贵档发现按章缓存：重跑便宜档后仍合并保留。 */
  private premium = new Map<string, PremiumFinding[]>();
  /** 各章贵档发现的 CR id（与 findings 同序；undefined=未落盘/MCP 降级）。 */
  private premiumIds = new Map<string, Array<string | undefined>>();
  /** 处置请求进行中的 CR id（防同一卡并发双击重发）。 */
  private disposingIds = new Set<string>();
  /** 当前审阅请求的取消控制器：run/runPremium 各自创建，cancel() 触发 abort。 */
  private ac: AbortController | null = null;
  /** 进行中的处置请求控制器（cancel() 一并中止）。 */
  private disposeAcs = new Map<string, AbortController>();

  init(client: CoreClient, workDir: string): void {
    this.client = client;
    this.workDir = workDir;
  }

  /** 顶栏入口：开视图并跑一轮扫描；已开则关（结果保留，徽标不丢）。
   * 后台跑着时重开只看进度/结果，不重跑（R5 后台可进行）。 */
  async toggle(): Promise<void> {
    if (this.open) {
      this.open = false;
      return;
    }
    this.open = true;
    if (!this.running) await this.run();
  }

  close(): void {
    // 可关后台（R5）：只收起视图，扫描/审阅继续在 store 单例里跑；重开可见进度与结果。
    this.open = false;
  }

  /** 取消当前审阅/处置请求：面板与后台态都可调用；running 锁在各自 finally 里释放。 */
  cancel(): void {
    this.ac?.abort();
    for (const ac of this.disposeAcs.values()) ac.abort();
  }

  /**
   * 竞速取消信号：abort 触发即注入 ReviewCancelled 拒绝；ac.signal 同时透传进 CoreClient
   * （RequestOptions.signal），请求本身在传输层一并中止，迟到结果按 aborted 忽略。
   */
  private guarded<T>(p: Promise<T>, ac: AbortController): Promise<T> {
    if (ac.signal.aborted) return Promise.reject(new ReviewCancelled());
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(new ReviewCancelled());
      ac.signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        (v) => {
          ac.signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          ac.signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  private cancelled(err: unknown, ac: AbortController): boolean {
    return err instanceof ReviewCancelled || ac.signal.aborted;
  }

  /**
   * 按档位跑审阅（R5）：quick=scan_quality；standard=+ledger_diagnostics（现状默认）；
   * deep=标准全部 + 当前章贵档冷读。各项独立成功/失败（items），部分成功照常出报告；
   * 取消静默释放锁不报错。
   */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.error = null;
    this.persistError = null;
    this.items = {};
    this.mode = 'scan';
    const level = this.level;
    const ac = new AbortController();
    this.ac = ac;
    try {
      // 全有全无改逐项结算：一段失败不再丢掉另一段的成功结果。
      const settle = <T>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: unknown }> =>
        this.guarded(p, ac).then(
          (v) => ({ ok: true as const, v }),
          (e) => ({ ok: false as const, e }),
        );
      const [scanRes, diagRes] = await Promise.all([
        settle(
          this.client.callTool<WorkScanResult>('scan_quality', { workDir: this.workDir }, {
            signal: ac.signal,
            timeoutMs: LONG_CALL_TIMEOUT_MS,
          }),
        ),
        level === 'quick'
          ? Promise.resolve(null)
          : settle(
              this.client.callTool<WorkDiagnostics>('ledger_diagnostics', {
                workDir: this.workDir,
                issueLogPath: ISSUE_LOG_DEFAULT,
              }, { signal: ac.signal, timeoutMs: LONG_CALL_TIMEOUT_MS }),
            ),
      ]);
      if (ac.signal.aborted) return; // 取消：静默释放锁，迟到结果一律忽略
      let scan: WorkScanResult | null = null;
      let diag: WorkDiagnostics | null = null;
      const failures: string[] = [];
      if (scanRes.ok) {
        scan = scanRes.v;
        this.items.scan = { status: 'ok' };
      } else {
        const msg = errText(scanRes.e);
        this.items.scan = { status: 'fail', error: msg };
        failures.push(`指标扫描失败：${msg}`);
      }
      if (level === 'quick') {
        this.items.diag = { status: 'skipped' };
      } else if (diagRes !== null && diagRes.ok) {
        diag = diagRes.v;
        this.items.diag = { status: 'ok' };
      } else if (diagRes !== null) {
        const msg = errText(diagRes.e);
        this.items.diag = { status: 'fail', error: msg };
        failures.push(`账本诊断失败：${msg}`);
      }
      if (scan !== null || diag !== null) {
        this.report = applyPremiumFindings(buildReviewReport(scan, diag), this.premium);
      }
      // 部分成功只在 items 里挂红字；全军覆没才进面板红条 + work.error 红条。
      if (failures.length > 0 && scan === null && diag === null) {
        const msg = `审阅扫描失败：${failures.join('；')}`;
        this.error = msg;
        work.error = msg;
      }
      // deep 档：确定性检查完成后自动对当前章追加贵档冷读（复用同一取消控制器）。
      if (level === 'deep') {
        if (!work.current) {
          this.error ??= '深度档需要先打开一个章节（贵档冷读按章进行）';
        } else {
          this.mode = 'premium';
          await this.premiumOnce(work.current.relPath, ac);
        }
      }
    } finally {
      if (this.ac === ac) this.ac = null;
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
    this.persistError = null;
    this.mode = 'premium';
    const ac = new AbortController();
    this.ac = ac;
    try {
      await this.premiumOnce(chapterRelPath, ac);
    } finally {
      if (this.ac === ac) this.ac = null;
      this.running = false;
    }
  }

  /** 贵档管道主体（runPremium 与 deep 档共用）；取消由调用方的 AbortController 注入。 */
  private async premiumOnce(chapterRelPath: string, ac: AbortController): Promise<void> {
    try {
      // 决策 0010：激活方案映射到 review 通道的 persona；无激活/无映射则 2 参调用不携带
      const persona = scheme.channelPersona('review');
      const base = persona
        ? this.client.review(this.workDir, chapterRelPath, persona, { signal: ac.signal, timeoutMs: LONG_CALL_TIMEOUT_MS })
        : this.client.review(this.workDir, chapterRelPath, undefined, { signal: ac.signal, timeoutMs: LONG_CALL_TIMEOUT_MS });
      const res = (await this.guarded(base, ac)) as PremiumReviewResponse;
      if (ac.signal.aborted) return;
      this.premium.set(chapterRelPath, res.findings);
      const ids = res.persisted?.ids ?? [];
      this.premiumIds.set(chapterRelPath, res.findings.map((_, i) => ids[i]));
      // findings 已到手但落盘失败要可见（否则作者会以为已进问题日志、可处置）。
      this.persistError = res.persistedError ?? null;
      this.report = applyPremiumFindings(this.report ?? emptyReviewReport(), this.premium);
    } catch (err) {
      if (this.cancelled(err, ac)) return;
      const msg = `贵档审阅失败：${err instanceof Error ? err.message : String(err)}`;
      this.error = msg;
      work.error = msg;
    }
  }

  /** 贵档发现的 CR id（未落盘/MCP 降级时为 undefined）。 */
  findingId(chapterRelPath: string, index: number): string | undefined {
    return this.premiumIds.get(chapterRelPath)?.[index];
  }

  /** 贵档发现的当前处置状态（无 CR id 或未处置为 undefined）。 */
  disposalOf(chapterRelPath: string, index: number): FindingDisposal | undefined {
    const id = this.findingId(chapterRelPath, index);
    return id ? this.disposed.get(id) : undefined;
  }

  /**
   * 处置贵档发现（闭环）：调 issue_set_status 标记 done/known，成功后本地标灰（状态进 disposed），
   * 该发现为 BLOCKER 时 blockerTotal 本地减一。无 CR id（未落盘/MCP 降级）不发请求直接返回 false。
   */
  async dispose(chapterRelPath: string, index: number, status: FindingDisposal): Promise<boolean> {
    const id = this.findingId(chapterRelPath, index);
    if (!id) return false;
    if (this.disposed.has(id) || this.disposingIds.has(id)) return true;
    this.disposingIds.add(id);
    // 处置请求同样可随全局取消中止（abort 后迟到结果忽略），失败/取消都释放 disposing 锁。
    const ac = new AbortController();
    this.disposeAcs.set(id, ac);
    try {
      const res = await this.guarded(
        this.client.callTool<{ ok: boolean; id: string; status: string }>(
          'issue_set_status',
          {
            workDir: this.workDir,
            issueLogPath: ISSUE_LOG_DEFAULT,
            id,
            status,
          },
          { signal: ac.signal },
        ),
        ac,
      );
      if (ac.signal.aborted) return false;
      if (res?.ok === false) {
        work.error = `处置失败：${res.status || '未返回原因'}`;
        return false;
      }
      this.disposed = new Map(this.disposed).set(id, status);
      return true;
    } catch (err) {
      if (this.cancelled(err, ac)) return false;
      work.error = `处置失败：${err instanceof Error ? err.message : String(err)}`;
      return false;
    } finally {
      this.disposingIds.delete(id);
      this.disposeAcs.delete(id);
    }
  }

  dismissError(): void {
    this.error = null;
  }
}

export const review = new ReviewStore();
