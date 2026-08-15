// review.svelte.ts 单测：审阅报告解析（超标过滤/诊断分组/BLOCKER 计数/干净态）+ 视图开关与扫描流程。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreClient } from './core.js';
import {
  applyPremiumFindings,
  buildReviewReport,
  emptyReviewReport,
  isExceeded,
  ReviewStore,
  ISSUE_LOG_PATH,
  type PremiumFinding,
  type WorkDiagnostics,
  type WorkScanResult,
} from './review.svelte.js';
import { work } from './work.svelte.js';

beforeEach(() => {
  work.error = null;
  work.notice = null;
});

function mockClient(callTool: ReturnType<typeof vi.fn>, review?: ReturnType<typeof vi.fn>): CoreClient {
  return { callTool, review: review ?? vi.fn() } as unknown as CoreClient;
}

function scanFixture(): WorkScanResult {
  return {
    workDir: 'C:/works/demo',
    chapters: [
      {
        relPath: 'manuscript/卷一/第1章.md',
        title: '第1章·少年',
        metrics: [
          { key: 'cjk', label: 'CJK 字数', standard: '≥2000', count: 2300, severity: 'pass', hits: [] },
          { key: 'dash', label: '破折号', standard: '≤20', count: 25, severity: 'fail', hits: [{ line: 9, text: '——' }] },
        ],
      },
      {
        relPath: 'manuscript/卷一/第2章.md',
        title: '第2章·客栈',
        metrics: [
          { key: 'notshi', label: '不是X是Y', standard: '≤2', count: 3, severity: 'warn', hits: [] },
          { key: 'scenes', label: '场景', standard: '', count: 2, severity: 'info', hits: [] },
        ],
      },
      {
        relPath: 'manuscript/卷一/第3章.md',
        title: '第3章·夜行',
        metrics: [{ key: 'cjk', label: 'CJK 字数', standard: '≥2000', count: 2100, severity: 'pass', hits: [] }],
      },
    ],
    book: { scenePool: ['a', 'b', 'c', 'd', 'e'], sceneContinuity: [], templateParagraphs: [] },
  };
}

function diagFixture(overrides: Partial<WorkDiagnostics> = {}): WorkDiagnostics {
  return {
    workDir: 'C:/works/demo',
    findings: [
      { code: 'overdue-promise', chapter: 'manuscript/卷一/第1章.md', severity: 'MAJOR', category: 'CONT', message: '伏笔逾期' },
      { code: 'season-conflict', chapter: 'manuscript/卷一/第2章.md', severity: 'MODERATE', category: 'CONT', message: '季节冲突' },
      { code: 'dangling-promise', severity: 'MODERATE', category: 'CONT', message: '账本级悬空伏笔' },
    ],
    hasBlockers: false,
    blockerCount: 0,
    ...overrides,
  };
}

describe('isExceeded', () => {
  it('warn/fail 算超标，pass/info 不算', () => {
    const base = { key: 'k', label: 'l', standard: '', count: 0, hits: [] };
    expect(isExceeded({ ...base, severity: 'warn' })).toBe(true);
    expect(isExceeded({ ...base, severity: 'fail' })).toBe(true);
    expect(isExceeded({ ...base, severity: 'pass' })).toBe(false);
    expect(isExceeded({ ...base, severity: 'info' })).toBe(false);
  });
});

describe('buildReviewReport', () => {
  it('逐章行只留超标指标；诊断按章分组，无章定位的进 bookFindings', () => {
    const r = buildReviewReport(scanFixture(), diagFixture());
    expect(r.chapters).toHaveLength(3);
    expect(r.chapters[0]!.metrics.map((m) => m.key)).toEqual(['dash']);
    expect(r.chapters[0]!.findings.map((f) => f.code)).toEqual(['overdue-promise']);
    expect(r.chapters[1]!.metrics.map((m) => m.key)).toEqual(['notshi']);
    expect(r.chapters[1]!.findings.map((f) => f.code)).toEqual(['season-conflict']);
    expect(r.chapters[2]!.metrics).toEqual([]);
    expect(r.chapters[2]!.findings).toEqual([]);
    expect(r.bookFindings.map((f) => f.code)).toEqual(['dangling-promise']);
    expect(r.scanFail).toBe(1);
    expect(r.scanWarn).toBe(1);
    expect(r.clean).toBe(false);
  });

  it('严重级计数 + BLOCKER 徽标 = BLOCKER 条目 + 问题日志条数', () => {
    const diag = diagFixture({
      findings: [
        { code: 'x', severity: 'BLOCKER', category: 'CONT', message: 'm' },
        { code: 'y', severity: 'MAJOR', category: 'CONT', message: 'm' },
      ],
      hasBlockers: true,
      blockerCount: 3,
    });
    const r = buildReviewReport(scanFixture(), diag);
    expect(r.counts).toEqual({ BLOCKER: 1, MAJOR: 1, MODERATE: 0, MINOR: 0 });
    expect(r.blockerTotal).toBe(4);
    expect(r.issueLogBlockers).toBe(3);
    expect(r.hasBlockers).toBe(true);
  });

  it('hasBlockers：domain 标记与本地计数任一成立即真', () => {
    const r1 = buildReviewReport(scanFixture(), diagFixture({ hasBlockers: true }));
    expect(r1.hasBlockers).toBe(true);
    const r2 = buildReviewReport(scanFixture(), diagFixture({ blockerCount: 2 }));
    expect(r2.hasBlockers).toBe(true);
    expect(r2.blockerTotal).toBe(2);
  });

  it('干净态：无超标指标、无诊断、无书级违规', () => {
    const scan = scanFixture();
    for (const c of scan.chapters) c.metrics = c.metrics.filter((m) => m.severity === 'pass' || m.severity === 'info');
    const r = buildReviewReport(scan, diagFixture({ findings: [] }));
    expect(r.clean).toBe(true);
    expect(r.blockerTotal).toBe(0);
    // 书级违规（跨章模板段落）破坏干净态
    const r2 = buildReviewReport(
      { ...scan, book: { ...scan.book, templateParagraphs: [{ opening: '他深吸一口气', chapters: ['a.md', 'b.md'] }] } },
      diagFixture({ findings: [] }),
    );
    expect(r2.clean).toBe(false);
  });
});

describe('applyPremiumFindings', () => {
  const premium: PremiumFinding[] = [
    { severity: 'BLOCKER', quote: '他死了。', why: '与账本冲突' },
    { severity: 'MAJOR', quote: '少年握拳。', why: '动作可更具体', suggestion: '补一句心理' },
  ];

  it('合并贵档发现进逐章行，并同步 counts/blockerTotal/hasBlockers/clean', () => {
    const base = buildReviewReport(scanFixture(), diagFixture());
    const r = applyPremiumFindings(base, new Map([['manuscript/卷一/第1章.md', premium]]));
    expect(r.chapters[0]!.premium).toEqual(premium);
    expect(r.counts.BLOCKER).toBe(1);
    expect(r.counts.MAJOR).toBe(2);
    expect(r.blockerTotal).toBe(1);
    expect(r.hasBlockers).toBe(true);
    expect(r.clean).toBe(false);
  });

  it('无确定性报告底座也能单独展示贵档章', () => {
    const r = applyPremiumFindings(emptyReviewReport(), new Map([['manuscript/卷一/第1章.md', premium]]));
    expect(r.chapters).toHaveLength(1);
    expect(r.chapters[0]!.relPath).toBe('manuscript/卷一/第1章.md');
    expect(r.chapters[0]!.premium).toEqual(premium);
    expect(r.counts.BLOCKER).toBe(1);
    expect(r.blockerTotal).toBe(1);
    expect(r.hasBlockers).toBe(true);
    expect(r.clean).toBe(false);
  });

  it('幂等：对同一报告重复 apply 不重复计数', () => {
    const base = buildReviewReport(scanFixture(), diagFixture());
    const map = new Map([['manuscript/卷一/第1章.md', premium]]);
    const once = applyPremiumFindings(base, map);
    const twice = applyPremiumFindings(once, map);
    expect(twice.counts).toEqual(once.counts);
    expect(twice.chapters[0]!.premium).toEqual(premium);
  });
});

describe('ReviewStore', () => {
  it('run：并行调 scan_quality + ledger_diagnostics，产出报告与徽标', async () => {
    const callTool = vi.fn((name: string) =>
      Promise.resolve(name === 'scan_quality' ? scanFixture() : diagFixture({ blockerCount: 2, hasBlockers: true })),
    );
    const s = new ReviewStore();
    s.init(mockClient(callTool), 'C:/works/demo');
    await s.run();
    expect(callTool).toHaveBeenCalledWith('scan_quality', { workDir: 'C:/works/demo' });
    expect(callTool).toHaveBeenCalledWith('ledger_diagnostics', {
      workDir: 'C:/works/demo',
      issueLogPath: ISSUE_LOG_PATH,
    });
    expect(s.report).not.toBeNull();
    expect(s.blockerTotal).toBe(2);
    expect(s.hasBlockers).toBe(true);
    expect(s.running).toBe(false);
  });

  it('toggle：开视图并跑扫描；再 toggle 关视图但徽标保留', async () => {
    const callTool = vi.fn((name: string) =>
      Promise.resolve(name === 'scan_quality' ? scanFixture() : diagFixture({ blockerCount: 1, hasBlockers: true })),
    );
    const s = new ReviewStore();
    s.init(mockClient(callTool), 'd');
    await s.toggle();
    expect(s.open).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(2);
    await s.toggle();
    expect(s.open).toBe(false);
    expect(s.blockerTotal).toBe(1); // 关掉视图后红点仍在（清零出口）
  });

  it('run 失败：work.error 红条，report 不变', async () => {
    const callTool = vi.fn().mockRejectedValue(new Error('core 掉线'));
    const s = new ReviewStore();
    s.init(mockClient(callTool), 'd');
    await s.run();
    expect(work.error).toContain('审阅扫描失败');
    expect(work.error).toContain('core 掉线');
    expect(s.report).toBeNull();
    expect(s.blockerTotal).toBe(0);
    expect(s.running).toBe(false);
  });

  it('running 互斥：扫描中重入不重复调工具', async () => {
    let resolveScan!: (v: WorkScanResult) => void;
    const callTool = vi.fn((name: string) => {
      if (name === 'scan_quality') return new Promise<WorkScanResult>((r) => (resolveScan = r));
      return Promise.resolve(diagFixture());
    });
    const s = new ReviewStore();
    s.init(mockClient(callTool), 'd');
    const p1 = s.run();
    const p2 = s.run();
    resolveScan(scanFixture());
    await Promise.all([p1, p2]);
    expect(callTool).toHaveBeenCalledTimes(2); // scan + diag 各一次
  });

  it('runPremium：调 client.review 合并进报告，BLOCKER 计数上升', async () => {
    const callTool = vi.fn((name: string) =>
      Promise.resolve(name === 'scan_quality' ? scanFixture() : diagFixture()),
    );
    const review = vi.fn().mockResolvedValue({
      findings: [{ severity: 'BLOCKER', quote: '他死了。', why: '与账本冲突' }],
    });
    const s = new ReviewStore();
    s.init(mockClient(callTool, review), 'C:/works/demo');
    await s.run();
    const before = s.blockerTotal;

    await s.runPremium('manuscript/卷一/第1章.md');
    expect(review).toHaveBeenCalledWith('C:/works/demo', 'manuscript/卷一/第1章.md');
    const row = s.report!.chapters.find((c) => c.relPath === 'manuscript/卷一/第1章.md')!;
    expect(row.premium).toHaveLength(1);
    expect(row.premium[0]!.severity).toBe('BLOCKER');
    expect(s.blockerTotal).toBe(before + 1);
    expect(s.running).toBe(false);
  });

  it('runPremium：不先跑便宜档也能单独展示贵档结果', async () => {
    const premium: PremiumFinding[] = [
      { severity: 'BLOCKER', quote: '他死了。', why: '与账本冲突' },
      { severity: 'MODERATE', quote: '少年握拳。', why: '动作可更具体' },
    ];
    const review = vi.fn().mockResolvedValue({ findings: premium });
    const s = new ReviewStore();
    s.init(mockClient(vi.fn(), review), 'C:/works/demo');

    await s.runPremium('manuscript/卷一/第1章.md');
    expect(s.report).not.toBeNull();
    expect(s.report!.chapters).toHaveLength(1);
    expect(s.report!.chapters[0]!.relPath).toBe('manuscript/卷一/第1章.md');
    expect(s.report!.chapters[0]!.premium).toEqual(premium);
    expect(s.blockerTotal).toBe(1);
    expect(s.running).toBe(false);
  });

  it('runPremium 失败：work.error 红条，report 不变', async () => {
    const review = vi.fn().mockRejectedValue(new Error('模型输出非法 JSON'));
    const s = new ReviewStore();
    s.init(mockClient(vi.fn(), review), 'd');
    await s.runPremium('manuscript/卷一/第1章.md');
    expect(work.error).toContain('贵档审阅失败');
    expect(work.error).toContain('模型输出非法 JSON');
    expect(s.report).toBeNull();
    expect(s.blockerTotal).toBe(0);
    expect(s.running).toBe(false);
  });

  it('runPremium：无打开章时报错且不调 client.review', async () => {
    const review = vi.fn();
    const s = new ReviewStore();
    s.init(mockClient(vi.fn(), review), 'd');
    await s.runPremium('');
    expect(review).not.toHaveBeenCalled();
    expect(work.error).toContain('请先打开一个章节');
    expect(s.report).toBeNull();
    expect(s.running).toBe(false);
  });

  it('run 失败：错误内嵌面板（review.error）红字区，失败后按钮恢复可点（running=false）', async () => {
    const callTool = vi.fn().mockRejectedValue(new Error('core 掉线'));
    const s = new ReviewStore();
    s.init(mockClient(callTool), 'd');
    await s.run();
    expect(s.error).toContain('审阅扫描失败');
    expect(s.error).toContain('core 掉线');
    expect(s.running).toBe(false);
    s.dismissError();
    expect(s.error).toBeNull();
  });

  it('runPremium 失败：错误内嵌面板，running 复位', async () => {
    const reviewFn = vi.fn().mockRejectedValue(new Error('模型输出非法 JSON'));
    const s = new ReviewStore();
    s.init(mockClient(vi.fn(), reviewFn), 'd');
    await s.runPremium('manuscript/第1章.md');
    expect(s.error).toContain('贵档审阅失败');
    expect(s.error).toContain('模型输出非法 JSON');
    expect(s.running).toBe(false);
  });

  it('mode 区分扫描/贵档冷读（进度文案用）', async () => {
    const callTool = vi.fn((name: string) =>
      Promise.resolve(name === 'scan_quality' ? scanFixture() : diagFixture()),
    );
    const reviewFn = vi.fn().mockResolvedValue({ findings: [] });
    const s = new ReviewStore();
    s.init(mockClient(callTool, reviewFn), 'C:/works/demo');
    await s.run();
    expect(s.mode).toBe('scan');
    await s.runPremium('manuscript/第1章.md');
    expect(s.mode).toBe('premium');
  });
});
