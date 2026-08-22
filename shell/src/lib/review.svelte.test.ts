// review.svelte.ts 单测：审阅报告解析（超标过滤/诊断分组/BLOCKER 计数/干净态）+ 视图开关与扫描流程。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreClient } from './core.js';
import {
  applyPremiumFindings,
  buildReviewReport,
  emptyReviewReport,
  isExceeded,
  ReviewStore,
  type PremiumFinding,
  type WorkDiagnostics,
  type WorkScanResult,
} from './review.svelte.js';
import { scheme } from './scheme.svelte.js';
import { work } from './work.svelte.js';
import { ISSUE_LOG_DEFAULT } from './paths.js';

beforeEach(() => {
  work.error = null;
  work.notice = null;
  // scheme 是模块单例：清方案态，避免 review persona 跨用例泄漏
  scheme.personas = [];
  scheme.schemes = [];
  scheme.activeScheme = null;
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
    expect(callTool).toHaveBeenCalledWith('scan_quality', { workDir: 'C:/works/demo' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(callTool).toHaveBeenCalledWith('ledger_diagnostics', {
      workDir: 'C:/works/demo',
      issueLogPath: ISSUE_LOG_DEFAULT,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
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
    expect(review).toHaveBeenCalledWith('C:/works/demo', 'manuscript/卷一/第1章.md', undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const row = s.report!.chapters.find((c) => c.relPath === 'manuscript/卷一/第1章.md')!;
    expect(row.premium).toHaveLength(1);
    expect(row.premium[0]!.severity).toBe('BLOCKER');
    expect(s.blockerTotal).toBe(before + 1);
    expect(s.running).toBe(false);
  });

  it('runPremium：激活方案映射 review persona → 调 client.review 带 persona（决策 0010）', async () => {
    const getPosture = vi.fn().mockResolvedValue({
      personas: [],
      schemes: [
        { name: 'S', description: '', channels: { chat: '外婆', rewrite: '童稚', review: '刺猬' }, source: 'work' },
      ],
      activeScheme: 'S',
    });
    const review = vi.fn().mockResolvedValue({ findings: [] });
    const s = new ReviewStore();
    s.init(mockClient(vi.fn(), review), 'C:/works/demo');
    scheme.init({ callTool: vi.fn(), review: vi.fn(), getPosture } as unknown as CoreClient);
    work.workDir = 'C:/works/demo';
    await scheme.load(); // activeScheme='S' → review 通道 persona='刺猬'
    await s.runPremium('manuscript/卷一/第1章.md');
    expect(review).toHaveBeenCalledWith('C:/works/demo', 'manuscript/卷一/第1章.md', '刺猬', expect.objectContaining({ signal: expect.any(AbortSignal) }));
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

describe('ReviewStore 处置闭环', () => {
  /** 构造一个带 persisted.ids 的贵档 client：issue_set_status 成功回显。 */
  function disposeClient(findings: PremiumFinding[], ids: string[]) {
    const callTool = vi.fn((name: string, args: Record<string, unknown>) => {
      if (name === 'issue_set_status') return Promise.resolve({ ok: true, id: args.id, status: args.status });
      return Promise.resolve(name === 'scan_quality' ? scanFixture() : diagFixture());
    });
    const reviewFn = vi.fn().mockResolvedValue({ findings, persisted: { appended: findings.length, ids } });
    return { callTool, reviewFn };
  }

  it('runPremium：persisted.ids 与 findings 同序存进 store；无 persisted 时为 undefined', async () => {
    const premium: PremiumFinding[] = [
      { severity: 'BLOCKER', quote: '他死了。', why: '与账本冲突' },
      { severity: 'MAJOR', quote: '少年握拳。', why: '动作可更具体' },
    ];
    const { reviewFn } = disposeClient(premium, ['cr-1', 'cr-2']);
    const s = new ReviewStore();
    s.init(mockClient(vi.fn(), reviewFn), 'C:/works/demo');
    await s.runPremium('manuscript/卷一/第1章.md');
    expect(s.findingId('manuscript/卷一/第1章.md', 0)).toBe('cr-1');
    expect(s.findingId('manuscript/卷一/第1章.md', 1)).toBe('cr-2');
    expect(s.disposalOf('manuscript/卷一/第1章.md', 0)).toBeUndefined();

    // 未落盘（无 persisted）：id 为 undefined，无法处置
    const s2 = new ReviewStore();
    s2.init(mockClient(vi.fn(), vi.fn().mockResolvedValue({ findings: premium })), 'd');
    await s2.runPremium('manuscript/卷一/第1章.md');
    expect(s2.findingId('manuscript/卷一/第1章.md', 0)).toBeUndefined();
  });

  it('dispose：按钮参数直达 callTool(issue_set_status)，成功后本地标灰、BLOCKER 计数减一', async () => {
    const { callTool, reviewFn } = disposeClient(
      [{ severity: 'BLOCKER', quote: '他死了。', why: '与账本冲突' }],
      ['cr-1'],
    );
    const s = new ReviewStore();
    s.init(mockClient(callTool, reviewFn), 'C:/works/demo');
    await s.runPremium('manuscript/卷一/第1章.md');
    expect(s.blockerTotal).toBe(1);

    const ok = await s.dispose('manuscript/卷一/第1章.md', 0, 'done');
    expect(ok).toBe(true);
    expect(callTool).toHaveBeenCalledWith('issue_set_status', {
      workDir: 'C:/works/demo',
      issueLogPath: ISSUE_LOG_DEFAULT,
      id: 'cr-1',
      status: 'done',
    }, { signal: expect.any(AbortSignal) });
    expect(s.disposalOf('manuscript/卷一/第1章.md', 0)).toBe('done');
    expect(s.blockerTotal).toBe(0); // 本地 BLOCKER 计数减一
    expect(s.running).toBe(false);
  });

  it('dispose：known 同样生效；非 BLOCKER 不减计数', async () => {
    const { callTool, reviewFn } = disposeClient(
      [{ severity: 'MAJOR', quote: '少年握拳。', why: '动作可更具体' }],
      ['cr-k'],
    );
    const s = new ReviewStore();
    s.init(mockClient(callTool, reviewFn), 'd');
    await s.runPremium('manuscript/第1章.md');
    expect(s.blockerTotal).toBe(0);

    const ok = await s.dispose('manuscript/第1章.md', 0, 'known');
    expect(ok).toBe(true);
    expect(callTool).toHaveBeenCalledWith('issue_set_status', expect.objectContaining({ id: 'cr-k', status: 'known' }), { signal: expect.any(AbortSignal) });
    expect(s.disposalOf('manuscript/第1章.md', 0)).toBe('known');
    expect(s.blockerTotal).toBe(0); // MAJOR 处置不减 BLOCKER 计数
  });

  it('dispose：重复处置幂等，不重发 callTool，状态保持首次', async () => {
    const { callTool, reviewFn } = disposeClient(
      [{ severity: 'BLOCKER', quote: 'q', why: 'w' }],
      ['cr-1'],
    );
    const s = new ReviewStore();
    s.init(mockClient(callTool, reviewFn), 'd');
    await s.runPremium('manuscript/第1章.md');

    expect(await s.dispose('manuscript/第1章.md', 0, 'done')).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(await s.dispose('manuscript/第1章.md', 0, 'known')).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(1); // 已处置不再发请求
    expect(s.disposalOf('manuscript/第1章.md', 0)).toBe('done');
  });

  it('dispose：无 CR id（未落盘/MCP 降级）不发请求，BLOCKER 计数不减', async () => {
    const callTool = vi.fn();
    const s = new ReviewStore();
    s.init(mockClient(callTool, vi.fn().mockResolvedValue({ findings: [{ severity: 'BLOCKER', quote: 'q', why: 'w' }] })), 'd');
    await s.runPremium('manuscript/第1章.md');
    expect(s.findingId('manuscript/第1章.md', 0)).toBeUndefined();

    const ok = await s.dispose('manuscript/第1章.md', 0, 'done');
    expect(ok).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
    expect(s.disposalOf('manuscript/第1章.md', 0)).toBeUndefined();
    expect(s.blockerTotal).toBe(1); // 未处置，BLOCKER 计数保留
  });

  it('dispose：callTool 失败时 work.error 红条、状态与计数不变', async () => {
    const callTool = vi.fn((name: string) => {
      if (name === 'issue_set_status') return Promise.reject(new Error('domain MCP 未连接'));
      return Promise.resolve(name === 'scan_quality' ? scanFixture() : diagFixture());
    });
    const reviewFn = vi.fn().mockResolvedValue({
      findings: [{ severity: 'BLOCKER', quote: 'q', why: 'w' }],
      persisted: { appended: 1, ids: ['cr-9'] },
    });
    const s = new ReviewStore();
    s.init(mockClient(callTool, reviewFn), 'd');
    await s.runPremium('manuscript/第1章.md');
    expect(s.blockerTotal).toBe(1);

    const ok = await s.dispose('manuscript/第1章.md', 0, 'done');
    expect(ok).toBe(false);
    expect(work.error).toContain('处置失败');
    expect(work.error).toContain('domain MCP 未连接');
    expect(s.disposalOf('manuscript/第1章.md', 0)).toBeUndefined();
    expect(s.blockerTotal).toBe(1); // 失败不扣减
  });
  it('dispose：取消后静默返回 false，不进红条，锁释放', async () => {
    let release!: () => void;
    const callTool = vi.fn((name: string) => {
      if (name === 'issue_set_status') return new Promise<{ ok: boolean }>((r) => (release = () => r({ ok: true })));
      return Promise.resolve(name === 'scan_quality' ? scanFixture() : diagFixture());
    });
    const reviewFn = vi.fn().mockResolvedValue({
      findings: [{ severity: 'BLOCKER', quote: 'q', why: 'w' }],
      persisted: { appended: 1, ids: ['cr-c'] },
    });
    const s = new ReviewStore();
    s.init(mockClient(callTool, reviewFn), 'd');
    await s.runPremium('manuscript/第1章.md');

    const p = s.dispose('manuscript/第1章.md', 0, 'done');
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledWith('issue_set_status', expect.anything(), expect.anything()));
    s.cancel();
    expect(await p).toBe(false);
    release();
    expect(work.error).toBeNull(); // 取消不算失败
    expect(s.disposalOf('manuscript/第1章.md', 0)).toBeUndefined();
  });
});

// ---------- R5：取消 / 分级 / 部分成功 ----------

describe('ReviewStore 取消', () => {
  it('run 中取消：锁立即释放、不进红条，迟到的结果不进报告', async () => {
    let resolveScan!: (v: WorkScanResult) => void;
    const callTool = vi.fn((name: string) => {
      if (name === 'scan_quality') return new Promise<WorkScanResult>((r) => (resolveScan = r));
      return Promise.resolve(diagFixture());
    });
    const s = new ReviewStore();
    s.init(mockClient(callTool), 'd');
    const p = s.run();
    await vi.waitFor(() => expect(callTool).toHaveBeenCalled());
    s.cancel();
    await p;
    expect(s.running).toBe(false);
    expect(s.error).toBeNull();
    expect(work.error).toBeNull();
    // 迟到 resolve 不得改写状态
    resolveScan(scanFixture());
    await new Promise((r) => setTimeout(r, 0));
    expect(s.report).toBeNull();
  });

  it('runPremium 中取消：锁释放、无红条，报告不变', async () => {
    let resolveReview!: (v: { findings: PremiumFinding[] }) => void;
    const reviewFn = vi.fn(
      () => new Promise<{ findings: PremiumFinding[] }>((r) => (resolveReview = r)),
    );
    const s = new ReviewStore();
    s.init(mockClient(vi.fn(), reviewFn), 'd');
    const p = s.runPremium('manuscript/第1章.md');
    await vi.waitFor(() => expect(reviewFn).toHaveBeenCalled());
    s.cancel();
    await p;
    expect(s.running).toBe(false);
    expect(s.error).toBeNull();
    expect(s.report).toBeNull();
    resolveReview({ findings: [{ severity: 'BLOCKER', quote: 'q', why: 'w' }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.report).toBeNull(); // 迟到的贵档结果被忽略
  });

  it('后台态取消入口：面板关着也能 cancel（close 不终止扫描，重开 toggle 不重跑）', async () => {
    let resolveScan!: (v: WorkScanResult) => void;
    const callTool = vi.fn((name: string) => {
      if (name === 'scan_quality') return new Promise<WorkScanResult>((r) => (resolveScan = r));
      return Promise.resolve(diagFixture());
    });
    const s = new ReviewStore();
    s.init(mockClient(callTool), 'd');
    void s.toggle(); // 开视图并开跑
    await vi.waitFor(() => expect(s.running).toBe(true));
    s.close(); // 关掉面板：扫描继续
    expect(s.running).toBe(true);
    await s.toggle(); // 重开：只看进度，不重跑
    expect(callTool).toHaveBeenCalledTimes(2); // scan + diag 各一次，未追加
    s.cancel();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.running).toBe(false);
  });
});

describe('ReviewStore 部分成功（逐项结算）', () => {
  it('scan 失败 diag 成功：报告由 diag 出，失败项带错误信息，不进全局红条', async () => {
    const callTool = vi.fn((name: string) =>
      name === 'scan_quality' ? Promise.reject(new Error('domain 僵死')) : Promise.resolve(diagFixture({ blockerCount: 1 })),
    );
    const s = new ReviewStore();
    s.init(mockClient(callTool), 'd');
    await s.run();
    expect(s.items.scan).toEqual({ status: 'fail', error: 'domain 僵死' });
    expect(s.items.diag).toEqual({ status: 'ok' });
    expect(s.error).toBeNull(); // 部分成功不算整体失败
    expect(work.error).toBeNull();
    expect(s.report).not.toBeNull();
    expect(s.report!.issueLogBlockers).toBe(1);
    expect(s.running).toBe(false);
  });

  it('scan 成功 diag 失败：逐章指标照常出，diag 失败项带错误信息', async () => {
    const callTool = vi.fn((name: string) =>
      name === 'scan_quality' ? Promise.resolve(scanFixture()) : Promise.reject(new Error('账本读取超时')),
    );
    const s = new ReviewStore();
    s.init(mockClient(callTool), 'd');
    await s.run();
    expect(s.items.scan).toEqual({ status: 'ok' });
    expect(s.items.diag).toEqual({ status: 'fail', error: '账本读取超时' });
    expect(s.report!.chapters.map((c) => c.relPath)).toContain('manuscript/卷一/第1章.md');
    expect(s.running).toBe(false);
  });

  it('全失败：保持旧口径——面板红条 + work.error 红条 + report 不变 + 锁释放', async () => {
    const callTool = vi.fn().mockRejectedValue(new Error('core 掉线'));
    const s = new ReviewStore();
    s.init(mockClient(callTool), 'd');
    await s.run();
    expect(s.items.scan?.status).toBe('fail');
    expect(s.items.diag?.status).toBe('fail');
    expect(s.error).toContain('审阅扫描失败');
    expect(work.error).toContain('审阅扫描失败');
    expect(s.report).toBeNull();
    expect(s.running).toBe(false);
  });

  it('落盘失败可见：review 带 persistedError → store.persistError 透出；下次跑前清', async () => {
    const reviewFn = vi.fn().mockResolvedValue({
      findings: [{ severity: 'MAJOR', quote: 'q', why: 'w' }],
      persistedError: 'issue_append 落盘超时（超过 30 秒）',
    });
    const s = new ReviewStore();
    s.init(mockClient(vi.fn(), reviewFn), 'd');
    await s.runPremium('manuscript/第1章.md');
    expect(s.persistError).toContain('落盘超时');

    reviewFn.mockResolvedValueOnce({ findings: [] }); // 下次跑前清
    await s.runPremium('manuscript/第2章.md');
    expect(s.persistError).toBeNull();
  });
});

describe('ReviewStore 分级扫描（R5）', () => {
  it('quick 档：只调 scan_quality，diag 标 skipped', async () => {
    const callTool = vi.fn((name: string) =>
      Promise.resolve(name === 'scan_quality' ? scanFixture() : diagFixture()),
    );
    const s = new ReviewStore();
    s.level = 'quick';
    s.init(mockClient(callTool), 'd');
    await s.run();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith('scan_quality', { workDir: 'd' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(s.items.scan).toEqual({ status: 'ok' });
    expect(s.items.diag).toEqual({ status: 'skipped' });
  });

  it('standard 档（默认）：scan_quality + ledger_diagnostics 都跑', async () => {
    const callTool = vi.fn((name: string) =>
      Promise.resolve(name === 'scan_quality' ? scanFixture() : diagFixture()),
    );
    const s = new ReviewStore();
    expect(s.level).toBe('standard'); // 默认档=现状行为
    s.init(mockClient(callTool), 'd');
    await s.run();
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('deep 档：确定性检查完成后自动对当前章追加贵档冷读', async () => {
    const callTool = vi.fn((name: string) =>
      Promise.resolve(name === 'scan_quality' ? scanFixture() : diagFixture()),
    );
    const reviewFn = vi.fn().mockResolvedValue({
      findings: [{ severity: 'BLOCKER', quote: '他死了。', why: '与账本冲突' }],
    });
    const s = new ReviewStore();
    s.level = 'deep';
    s.init(mockClient(callTool, reviewFn), 'C:/works/demo');
    work.current = { relPath: 'manuscript/卷一/第1章.md', title: '第1章', frontmatter: {}, frontmatterRaw: '', savedMd: '' };
    try {
      await s.run();
      expect(callTool).toHaveBeenCalledTimes(2);
      expect(reviewFn).toHaveBeenCalledWith('C:/works/demo', 'manuscript/卷一/第1章.md', undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(s.mode).toBe('premium');
      const row = s.report!.chapters.find((c) => c.relPath === 'manuscript/卷一/第1章.md')!;
      expect(row.premium).toHaveLength(1);
      expect(s.running).toBe(false);
    } finally {
      work.current = null;
    }
  });

  it('deep 档无当前章：确定性结果照常出，面板提示需先打开章节', async () => {
    const callTool = vi.fn((name: string) =>
      Promise.resolve(name === 'scan_quality' ? scanFixture() : diagFixture()),
    );
    const reviewFn = vi.fn();
    const s = new ReviewStore();
    s.level = 'deep';
    s.init(mockClient(callTool, reviewFn), 'd');
    work.current = null;
    await s.run();
    expect(reviewFn).not.toHaveBeenCalled();
    expect(s.error).toContain('深度档需要先打开一个章节');
    expect(s.report).not.toBeNull();
    expect(s.running).toBe(false);
  });
});
