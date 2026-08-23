// candidates.svelte.ts 单测：暂存区加载/选择、流式创建、批量采纳（同章/跨章/失败项）、整改、丢弃。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreClient, RewriteStreamHandlers } from './core.js';
import type { Candidate } from './types.js';
import { CandidatesStore } from './candidates.svelte.js';
import { scheme } from './scheme.svelte.js';
import { snapshot } from './snapshot.svelte.js';
import { work } from './work.svelte.js';

const CAND: Candidate = {
  id: 'c1',
  sessionId: null,
  chapter: '章节A.md',
  kind: 'replace',
  original: '原文X',
  proposed: '改写X',
  instruction: '润色',
  status: 'pending',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
};

function clientOf(overrides: Record<string, unknown> = {}): CoreClient {
  return {
    listCandidates: vi.fn().mockResolvedValue({ candidates: [] }),
    createCandidate: vi.fn().mockResolvedValue({ candidate: CAND }),
    patchCandidate: vi.fn().mockResolvedValue({ candidate: CAND }),
    rewriteStream: vi.fn().mockResolvedValue(undefined),
    // 采纳落定后会 fire-and-forget 触发章摘要生成（POST /v1/summary/generate）
    generateSummary: vi.fn().mockResolvedValue({ ok: true, frozen: true, record: { relPath: '', summary: '' } }),
    callTool: vi.fn().mockResolvedValue(undefined),
    // 采纳会触发 work.saveCurrent → 保存成功后 fire-and-forget 落账（任务 1b）
    recordStatsSnapshot: vi.fn().mockResolvedValue({ date: '2026-08-12', words: 100, prev: null, delta: null }),
    ...overrides,
  } as unknown as CoreClient;
}

/** 流式改写 mock：同步触发 onDone 并带出文本。 */
function rewriteDone(text: string) {
  return vi.fn().mockImplementation(async (_b: unknown, h: RewriteStreamHandlers) => {
    h.onDelta?.(text);
    h.onDone?.({ text });
  });
}

beforeEach(() => {
  work.workDir = '';
  work.error = null;
  work.notice = null;
  work.current = null;
  work.structure = [];
  work.dirty = false;
  work.saving = false;
  work.registerEditor(null);
  // scheme 是模块单例：清方案态，避免 rewrite persona 跨用例泄漏
  scheme.personas = [];
  scheme.schemes = [];
  scheme.activeScheme = null;
});

describe('CandidatesStore', () => {
  it('load：填充 pending 列表并递增 revision；失败红条', async () => {
    const client = clientOf({ listCandidates: vi.fn().mockResolvedValue({ candidates: [CAND] }) });
    const store = new CandidatesStore();
    store.init(client);
    await store.load();
    expect(store.items).toEqual([CAND]);
    expect(store.revision).toBe(1);
    expect(store.pendingCount).toBe(1);

    const failClient = clientOf({ listCandidates: vi.fn().mockRejectedValue(new Error('core 挂了')) });
    const store2 = new CandidatesStore();
    store2.init(failClient);
    await store2.load();
    expect(work.error).toContain('暂存区加载失败');
  });

  it('选择逻辑：单选/全选/清空/计数；openStaging 打开 tab 并加载', async () => {
    const client = clientOf();
    const store = new CandidatesStore();
    store.init(client);
    store.openStaging();
    expect(store.stagingTab).toBe(true);
    expect(store.viewingId).toBe(null);
    expect(client.listCandidates).toHaveBeenCalledWith({ status: 'pending' });

    store.items = [CAND, { ...CAND, id: 'c2' }];
    store.toggleSelect('c1');
    expect(store.selected.has('c1')).toBe(true);
    expect(store.selectedCount).toBe(1);
    store.toggleSelectAll();
    expect(store.selected.size).toBe(2);
    store.toggleSelectAll(); // 已全选 → 清空
    expect(store.selected.size).toBe(0);
    store.toggleSelect('c2');
    store.clearSelection();
    expect(store.selected.size).toBe(0);
  });

  it('createFromSelection：流式累积 → 进暂存区 → 列表前置、返回 true', async () => {
    const createCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const client = clientOf({
      rewriteStream: rewriteDone('改写X'),
      createCandidate,
    });
    const store = new CandidatesStore();
    store.init(client);
    const progress: string[] = [];
    const ok = await store.createFromSelection('章节A.md', '原文X', '润色', (t) => progress.push(t));
    expect(ok).toBe(true);
    expect(progress).toContain('改写X');
    expect(createCandidate).toHaveBeenCalledWith({
      chapter: '章节A.md',
      original: '原文X',
      proposed: '改写X',
      instruction: '润色',
    });
    expect(store.items[0]?.id).toBe('c1');
    expect(store.revision).toBe(1);
  });

  it('createFromSelection：改写失败 → 红条 + 返回 false，不进暂存区', async () => {
    const createCandidate = vi.fn();
    const client = clientOf({
      rewriteStream: vi.fn().mockImplementation(async (_b: unknown, h: RewriteStreamHandlers) => {
        h.onError?.(new Error('输出护栏拒绝'));
      }),
      createCandidate,
    });
    const store = new CandidatesStore();
    store.init(client);
    const ok = await store.createFromSelection('章节A.md', '原文X', '润色');
    expect(ok).toBe(false);
    expect(work.error).toContain('AI 改写失败');
    expect(createCandidate).not.toHaveBeenCalled();
    expect(store.items).toEqual([]);
  });

  it('createFromSelection / rewriteText：激活方案映射 rewrite persona → 请求体带 persona（决策 0010）', async () => {
    const getPosture = vi.fn().mockResolvedValue({
      personas: [],
      schemes: [
        { name: 'S', description: '', channels: { chat: '外婆', rewrite: '童稚', review: '刺猬' }, source: 'work' },
      ],
      activeScheme: 'S',
    });
    const rewriteStream = vi.fn((_b: unknown, h: RewriteStreamHandlers) => {
      h.onDelta?.('改写X');
      h.onDone?.({ text: '改写X' });
    });
    const createCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const client = clientOf({ rewriteStream, createCandidate, getPosture });
    const store = new CandidatesStore();
    store.init(client);
    scheme.init(client);
    work.workDir = 'C:/works/demo';
    await scheme.load(); // activeScheme='S' → rewrite 通道 persona='童稚'
    await store.createFromSelection('章节A.md', '原文X', '润色');
    const body = (rewriteStream as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toMatchObject({ original: '原文X', instruction: '润色', workDir: 'C:/works/demo', persona: '童稚' });
    store.clearSelection();
    // 就地浮层改写同样带 persona
    await store.rewriteText('原文X', '润色', undefined, 'C:/works/demo');
    const body2 = (rewriteStream as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as Record<string, unknown>;
    expect(body2).toMatchObject({ original: '原文X', instruction: '润色', workDir: 'C:/works/demo', persona: '童稚' });
  });

  it('rectifySelected：激活方案映射 rewrite persona → 整改请求体带 persona', async () => {
    const getPosture = vi.fn().mockResolvedValue({
      personas: [],
      schemes: [
        { name: 'S', description: '', channels: { chat: '外婆', rewrite: '童稚', review: '刺猬' }, source: 'work' },
      ],
      activeScheme: 'S',
    });
    const rewriteStream = vi.fn((_b: unknown, h: RewriteStreamHandlers) => {
      h.onDelta?.('整改后文本');
      h.onDone?.({ text: '整改后文本' });
    });
    const patchCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const client = clientOf({ rewriteStream, patchCandidate, getPosture });
    const store = new CandidatesStore();
    store.init(client);
    scheme.init(client);
    work.workDir = 'C:/works/demo';
    await scheme.load();
    store.items = [CAND];
    store.toggleSelect('c1');
    await store.rectifySelected('换成爽文节奏');
    const body = (rewriteStream as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toMatchObject({ workDir: 'C:/works/demo', persona: '童稚' });
    expect(String(body.instruction)).toContain('整改要求：换成爽文节奏');
  });

  it('无激活方案：改写请求体不带 persona（决策 0010）', async () => {
    const rewriteStream = vi.fn((_b: unknown, h: RewriteStreamHandlers) => {
      h.onDelta?.('改写X');
      h.onDone?.({ text: '改写X' });
    });
    const createCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const client = clientOf({ rewriteStream, createCandidate });
    const store = new CandidatesStore();
    store.init(client);
    work.workDir = 'C:/works/demo';
    await store.createFromSelection('章节A.md', '原文X', '润色');
    const body = (rewriteStream as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toMatchObject({ original: '原文X', instruction: '润色', workDir: 'C:/works/demo' });
    expect(Object.prototype.hasOwnProperty.call(body, 'persona')).toBe(false);
  });

  it('adoptSelected：同章逐条替换 → adopted 落库 → 保存 → 清选择', async () => {
    const patchCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const callTool = vi.fn().mockResolvedValue(undefined); // write_chapter + 后台刷树
    const client = clientOf({ patchCandidate, callTool });
    const store = new CandidatesStore();
    store.init(client);
    work.init(client, 'C:/works/demo');
    work.current = { relPath: '章节A.md', title: '章节A', frontmatter: {}, frontmatterRaw: '---\n---\n', savedMd: '原文X' };
    work.registerEditor({ getMd: () => '原文X改写X', applyEdit: () => 'ok', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });

    store.items = [CAND];
    store.toggleSelect('c1');
    await store.adoptSelected();
    expect(patchCandidate).toHaveBeenCalledWith('c1', { status: 'adopted' });
    expect(callTool).toHaveBeenCalledWith('write_chapter', expect.objectContaining({ relPath: '章节A.md' }));
    expect(store.selected.size).toBe(0);
    expect(store.busy).toBe(false);
  });

  it('adoptSelected：锚点失效的候选进失败红条，成功的照常采纳', async () => {
    const patchCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const client = clientOf({ patchCandidate });
    const store = new CandidatesStore();
    store.init(client);
    work.current = { relPath: '章节A.md', title: '章节A', frontmatter: {}, frontmatterRaw: '---\n---\n', savedMd: 'x' };
    work.registerEditor({ getMd: () => 'x', applyEdit: () => 'not-found', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });

    store.items = [CAND, { ...CAND, id: 'c2' }];
    store.toggleSelect('c1');
    store.toggleSelect('c2');
    await store.adoptSelected();
    expect(work.error).toContain('部分候选未能采纳');
    expect(work.error).toContain('找不到锚点');
    expect(patchCandidate).not.toHaveBeenCalled(); // 全部失败 → 无落库
    expect(store.busy).toBe(false);
  });

  it('adoptSelected：跨章采纳 → 先开目标章再替换保存', async () => {
    const patchCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ content: '其他正文', frontmatter: {}, frontmatterRaw: '---\n---\n', body: '其他正文' }) // read_chapter
      .mockResolvedValueOnce(undefined) // write_chapter
      .mockResolvedValue({ type: 'volume', title: '第一卷', children: [] }); // 后台刷树 + 采纳后诊断/对账（空 findings/anchors）
    const client = clientOf({ patchCandidate, callTool });
    const store = new CandidatesStore();
    store.init(client);
    // 当前在另一章，目标章在结构树里
    work.init(client, 'C:/works/demo');
    work.current = { relPath: '章节B.md', title: '章节B', frontmatter: {}, frontmatterRaw: '---\n---\n', savedMd: 'b' };
    work.structure = [{ type: 'volume', title: '第一卷', children: [{ type: 'chapter', title: '章节A', relPath: '章节A.md', wordCount: 1, scenes: [] }] }];
    work.registerEditor({ getMd: () => '其他正文改', applyEdit: () => 'ok', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });

    store.items = [CAND];
    store.toggleSelect('c1');
    await store.adoptSelected();
    expect(callTool).toHaveBeenCalledWith('read_chapter', expect.objectContaining({ relPath: '章节A.md' }));
    expect(work.current?.relPath).toBe('章节A.md');
    expect(patchCandidate).toHaveBeenCalledWith('c1', { status: 'adopted' });
  });

  it('anchoredIn：只回该章 kind=replace 且 original 非空（append/replace_all/空锚点被滤）', () => {
    const store = new CandidatesStore();
    store.items = [
      { ...CAND, id: 'a' }, // replace 且有锚点 → 保留
      { ...CAND, id: 'b', kind: 'append', original: '' },
      { ...CAND, id: 'c', kind: 'replace_all', original: '' },
      { ...CAND, id: 'd', chapter: '章节B.md' }, // 别的章
      { ...CAND, id: 'e', original: '' }, // replace 但无锚点
      { ...CAND, id: 'f', kind: 'append' }, // append 即使有 original 也不装饰
    ];
    expect(store.anchoredIn('章节A.md').map((i) => i.id)).toEqual(['a']);
  });

  it('adopt：按 kind 分派 append→appendMd / replace_all→replaceBodyMd / replace→applyEdit', async () => {
    const patchCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const callTool = vi.fn().mockResolvedValue(undefined);
    const client = clientOf({ patchCandidate, callTool });
    const store = new CandidatesStore();
    store.init(client);
    work.init(client, 'C:/works/demo');
    work.current = { relPath: '章节A.md', title: '章节A', frontmatter: {}, frontmatterRaw: '---\n---\n', savedMd: 'x' };
    const applyEdit = vi.fn<(original: string, proposed: string) => 'ok' | 'not-found' | 'ambiguous'>(() => 'ok');
    const appendMd = vi.fn<(md: string) => 'ok' | 'not-found'>(() => 'ok');
    const replaceBodyMd = vi.fn<(md: string) => 'ok' | 'not-found'>(() => 'ok');
    work.registerEditor({ getMd: () => 'x', applyEdit, appendMd, replaceBodyMd });

    store.items = [
      { ...CAND, id: 're' }, // kind=replace
      { ...CAND, id: 'ap', kind: 'append', original: '' },
      { ...CAND, id: 'ra', kind: 'replace_all', original: '' },
    ];
    store.toggleSelect('re');
    store.toggleSelect('ap');
    store.toggleSelect('ra');
    await store.adoptSelected();
    expect(applyEdit).toHaveBeenCalledWith('原文X', '改写X');
    expect(appendMd).toHaveBeenCalledWith('改写X');
    expect(replaceBodyMd).toHaveBeenCalledWith('改写X');
    expect(patchCandidate).toHaveBeenCalledWith('re', { status: 'adopted' });
    expect(patchCandidate).toHaveBeenCalledWith('ap', { status: 'adopted' });
    expect(patchCandidate).toHaveBeenCalledWith('ra', { status: 'adopted' });
    expect(store.busy).toBe(false);
  });

  it('adopt：append / replace_all 失败（编辑器未就绪）→ 各自失败文案，replace 照常', async () => {
    const patchCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const client = clientOf({ patchCandidate });
    const store = new CandidatesStore();
    store.init(client);
    work.current = { relPath: '章节A.md', title: '章节A', frontmatter: {}, frontmatterRaw: '---\n---\n', savedMd: 'x' };
    work.registerEditor({ getMd: () => 'x', applyEdit: () => 'ok', appendMd: () => 'not-found', replaceBodyMd: () => 'not-found' });

    store.items = [
      { ...CAND, id: 're' },
      { ...CAND, id: 'ap', kind: 'append', original: '' },
      { ...CAND, id: 'ra', kind: 'replace_all', original: '' },
    ];
    store.toggleSelect('re');
    store.toggleSelect('ap');
    store.toggleSelect('ra');
    await store.adoptSelected();
    expect(work.error).toContain('部分候选未能采纳');
    expect(work.error).toContain('追加失败：编辑器未就绪');
    expect(work.error).toContain('整章替换失败：编辑器未就绪');
    expect(patchCandidate).toHaveBeenCalledWith('re', { status: 'adopted' });
    expect(patchCandidate).not.toHaveBeenCalledWith('ap', expect.anything());
    expect(patchCandidate).not.toHaveBeenCalledWith('ra', expect.anything());
    expect(store.busy).toBe(false);
  });

  it('discardSelected：批量丢弃 → 状态落库 → 重载列表 → 清选择', async () => {
    const patchCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const listCandidates = vi.fn().mockResolvedValue({ candidates: [] });
    const client = clientOf({ patchCandidate, listCandidates });
    const store = new CandidatesStore();
    store.init(client);
    store.items = [CAND];
    store.toggleSelect('c1');
    await store.discardSelected();
    expect(patchCandidate).toHaveBeenCalledWith('c1', { status: 'discarded' });
    expect(listCandidates).toHaveBeenCalledWith({ status: 'pending' });
    expect(store.items).toEqual([]);
    expect(store.selected.size).toBe(0);
  });

  it('rectifySelected：整改重写 → proposed/instruction 留痕更新 + 本地即时刷新', async () => {
    const patchCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const client = clientOf({
      rewriteStream: rewriteDone('整改后文本'),
      patchCandidate,
    });
    const store = new CandidatesStore();
    store.init(client);
    store.items = [CAND];
    store.toggleSelect('c1');
    await store.rectifySelected('换成爽文节奏');
    expect(patchCandidate).toHaveBeenCalledWith('c1', {
      proposed: '整改后文本',
      instruction: '润色 / 整改：换成爽文节奏',
    });
    expect(store.items[0]?.proposed).toBe('整改后文本');
    expect(store.items[0]?.instruction).toBe('润色 / 整改：换成爽文节奏');
    expect(store.selected.size).toBe(0);
    expect(store.busy).toBe(false);
  });

  it('rectifyOne（全览发起）：流式期间 allItems 逐批更新（整改过程实时可见）', async () => {
    const patchCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const seen: Array<string | undefined> = [];
    const listCandidates = vi.fn().mockResolvedValue({
      candidates: [{ ...CAND, proposed: '整改完成', instruction: '润色 / 整改：加细节' }],
    });
    const client = clientOf({
      rewriteStream: vi.fn().mockImplementation(async (_b: unknown, h: RewriteStreamHandlers) => {
        h.onDelta?.('整改中');
        seen.push(store.allItems[0]?.proposed); // 流式第一拍：allItems 已更新
        h.onDelta?.('整改完成');
        seen.push(store.allItems[0]?.proposed); // 流式第二拍：继续追加
        h.onDone?.({ text: '整改完成' });
      }),
      patchCandidate,
      listCandidates,
    });
    const store = new CandidatesStore();
    store.init(client);
    store.overviewOpen = true;
    store.allItems = [CAND];
    await store.rectifyOne(CAND, '加细节');
    expect(seen).toEqual(['整改中', '整改中整改完成']); // 全览数据源随 delta 增量实时更新
    expect(patchCandidate).toHaveBeenCalledWith('c1', {
      proposed: '整改完成',
      instruction: '润色 / 整改：加细节',
    });
    expect(store.allItems[0]?.proposed).toBe('整改完成'); // 完成后 loadAll 刷新一致
  });
});

describe('CandidatesStore · 采纳后自动诊断 + 对账合并提示 + 章摘要触发', () => {
  beforeEach(() => {
    snapshot.dismissNotice();
  });

  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  function adoptContext(overrides: Record<string, unknown> = {}): { store: CandidatesStore; callTool: ReturnType<typeof vi.fn>; generateSummary: ReturnType<typeof vi.fn> } {
    const patchCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const callTool = vi.fn((name: string) => {
      if (name === 'ledger_diagnostics') {
        return Promise.resolve({
          findings: [
            { severity: 'MAJOR', category: 'clock', message: '时钟冲突' },
            { severity: 'BLOCKER', category: 'promise', message: '伏笔未收' },
          ],
          hasBlockers: true,
          blockerCount: 1,
        });
      }
      if (name === 'ledger_reconcile') {
        // chapterMissing+quoteMissing=3 计入提醒；lineDrift=9 提示级不计入
        return Promise.resolve({ workDir: 'C:/works/demo', anchors: { checked: 5, ok: 2, chapterMissing: 1, quoteMissing: 2, lineDrift: 9 } });
      }
      return Promise.resolve(undefined);
    });
    const generateSummary = vi.fn().mockResolvedValue({ ok: true, frozen: true, record: { relPath: '', summary: '' } });
    const client = clientOf({ patchCandidate, callTool, generateSummary, ...overrides });
    const store = new CandidatesStore();
    store.init(client);
    work.init(client, 'C:/works/demo');
    work.current = { relPath: '章节A.md', title: '章节A', frontmatter: {}, frontmatterRaw: '---\n---\n', savedMd: '原文X' };
    work.registerEditor({ getMd: () => '原文X改写X', applyEdit: () => 'ok', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });
    store.items = [CAND];
    store.toggleSelect('c1');
    return { store, callTool, generateSummary };
  }

  it('adoptSelected：采纳落定后诊断 + 对账并行跑，合并计数弹一次轻提示（lineDrift 不计入对账提醒）', async () => {
    const { store, callTool } = adoptContext();
    await store.adoptSelected();
    await flush();
    expect(callTool).toHaveBeenCalledWith('ledger_diagnostics', {
      workDir: 'C:/works/demo',
      issueLogPath: 'editorial_notes/issues.md',
    });
    expect(callTool).toHaveBeenCalledWith('ledger_reconcile', { workDir: 'C:/works/demo' });
    expect(snapshot.notice?.message).toContain('诊断 2 条');
    expect(snapshot.notice?.message).toContain('对账 3 处锚异常');
    expect(snapshot.notice?.message).not.toContain('9');
    expect(snapshot.notice?.message).not.toContain('若采纳改变了剧情事实');
  });

  it('adoptSelected：有发现时轻提示带「让 AI 同步账本」引导按钮，prefillChat 含涉及章节清单（T12）', async () => {
    const { store } = adoptContext();
    await store.adoptSelected();
    await flush();
    expect(snapshot.notice?.action).toBeDefined();
    expect(snapshot.notice?.action?.label).toBe('让 AI 同步账本');
    expect(snapshot.notice?.action?.prefillChat).toContain('章节A.md');
    // 结构化引导三要点：先列清单给我确认、确认后才写账本、无变动回无需同步
    expect(snapshot.notice?.action?.prefillChat).toContain('先列出');
    expect(snapshot.notice?.action?.prefillChat).toContain('我确认后你再写账本');
    expect(snapshot.notice?.action?.prefillChat).toContain('无需同步');
    // 尾部纯文本指引已从 message 移除，改为 action 按钮
    expect(snapshot.notice?.message).not.toContain('让 AI 同步账本');
  });

  it('adoptSelected：诊断无 findings 且对账无锚异常 → 不弹提示（不打扰）', async () => {
    const { store } = adoptContext({
      callTool: vi.fn((name: string) => {
        if (name === 'ledger_diagnostics') return Promise.resolve({ findings: [], hasBlockers: false, blockerCount: 0 });
        if (name === 'ledger_reconcile') return Promise.resolve({ workDir: 'C:/works/demo', anchors: { checked: 5, ok: 5, chapterMissing: 0, quoteMissing: 0, lineDrift: 2 } });
        return Promise.resolve(undefined);
      }),
    });
    await store.adoptSelected();
    await flush();
    expect(snapshot.notice).toBeNull();
  });

  it('adoptSelected：诊断调用失败但对账有锚异常 → 只按对账计数提示（任一失败不影响另一个）', async () => {
    const { store } = adoptContext({
      callTool: vi.fn((name: string) => {
        if (name === 'ledger_diagnostics') return Promise.reject(new Error('core 掉线'));
        if (name === 'ledger_reconcile') return Promise.resolve({ workDir: 'C:/works/demo', anchors: { checked: 5, ok: 4, chapterMissing: 1, quoteMissing: 0, lineDrift: 0 } });
        return Promise.resolve(undefined);
      }),
    });
    await store.adoptSelected();
    await flush();
    expect(snapshot.notice?.message).toContain('对账 1 处锚异常');
    expect(snapshot.notice?.message).not.toContain('诊断');
    expect(work.error).toBeNull(); // 不污染采纳主链路
  });

  it('adoptSelected：对账调用失败但诊断有 findings → 只按诊断计数提示', async () => {
    const { store } = adoptContext({
      callTool: vi.fn((name: string) => {
        if (name === 'ledger_diagnostics') return Promise.resolve({ findings: [{ severity: 'MAJOR', message: 'x' }] });
        if (name === 'ledger_reconcile') return Promise.reject(new Error('core 掉线'));
        return Promise.resolve(undefined);
      }),
    });
    await store.adoptSelected();
    await flush();
    expect(snapshot.notice?.message).toContain('诊断 1 条');
    expect(snapshot.notice?.message).not.toContain('对账');
  });

  it('adoptSelected：采纳后对每个受影响章 fire-and-forget 触发章摘要生成，失败静默不报红条', async () => {
    const { store, generateSummary } = adoptContext();
    await store.adoptSelected();
    expect(generateSummary).toHaveBeenCalledTimes(1);
    expect(generateSummary).toHaveBeenCalledWith('C:/works/demo', '章节A.md');
    await flush();
    expect(work.error).toBeNull();

    // 摘要是导生缓存：失败被吞，下次采纳会重建，不影响采纳结果
    const genFail = vi.fn().mockRejectedValue(new Error('LLM 超时'));
    const ctx2 = adoptContext({ generateSummary: genFail });
    await ctx2.store.adoptSelected();
    await flush();
    expect(genFail).toHaveBeenCalledTimes(1);
    expect(work.error).toBeNull();
  });

  it('adoptSelected：跨章采纳 → 对每个受影响章各触发一次章摘要生成', async () => {
    const patchCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const generateSummary = vi.fn().mockResolvedValue({ ok: true, frozen: true, record: { relPath: '', summary: '' } });
    const callTool = vi.fn().mockResolvedValue(undefined); // write_chapter / 后台刷树 / 诊断 / 对账全空
    const listCandidates = vi.fn().mockResolvedValue({ candidates: [] });
    const client = clientOf({ patchCandidate, generateSummary, callTool, listCandidates });
    const store = new CandidatesStore();
    store.init(client);
    work.init(client, 'C:/works/demo');
    work.structure = [
      { type: 'volume', title: '第一卷', children: [{ type: 'chapter', title: 'A', relPath: 'A.md', wordCount: 1, scenes: [] }] },
      { type: 'volume', title: '第二卷', children: [{ type: 'chapter', title: 'B', relPath: 'B.md', wordCount: 1, scenes: [] }] },
    ];
    // 当前在 A 章，采纳 A 章一条 + B 章一条（B 需先开章：read_chapter 回包）
    const TREE = work.structure; // 后台刷树回同一棵树，避免 structure 被后台 loadStructure 打空
    (callTool as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'read_chapter') return Promise.resolve({ content: 'b', frontmatter: {}, frontmatterRaw: '---\n---\n', body: 'b' });
      if (name === 'list_structure') return Promise.resolve(TREE);
      return Promise.resolve(undefined);
    });
    work.registerEditor({ getMd: () => 'x改写X', applyEdit: () => 'ok', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });
    store.items = [{ ...CAND, chapter: 'A.md' }, { ...CAND, id: 'c2', chapter: 'B.md' }];
    store.toggleSelect('c1');
    store.toggleSelect('c2');
    await store.adoptSelected();
    await flush();
    expect(generateSummary).toHaveBeenCalledWith('C:/works/demo', 'A.md');
    expect(generateSummary).toHaveBeenCalledWith('C:/works/demo', 'B.md');
    expect(generateSummary).toHaveBeenCalledTimes(2);
  });
});

describe('CandidatesStore · 触发式续写', () => {
  it('done 后创建 append 候选，且在飞时防重入', async () => {
    let release!: () => void;
    const continueText = vi.fn().mockImplementation((_body: unknown, h: { onText: (text: string) => void; onDone?: (done: { text: string }) => void }) =>
      new Promise<void>((resolve) => {
        release = () => { h.onText('续写文本'); h.onDone?.({ text: '续写文本' }); resolve(); };
      }),
    );
    const createCandidate = vi.fn().mockResolvedValue({ candidate: { ...CAND, kind: 'append', original: '', proposed: '续写文本', instruction: '续写' } });
    const store = new CandidatesStore();
    store.init(clientOf({ continueText, createCandidate }));
    work.init(clientOf(), 'C:/works/demo');
    work.current = { relPath: '章节A.md', title: '章节A', frontmatter: {}, frontmatterRaw: '', savedMd: '正文' };
    work.registerEditor({ getMd: () => '当前正文', applyEdit: () => 'ok', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });
    const first = store.continueFromChapter();
    expect(store.continuing).toBe(true);
    expect(await store.continueFromChapter()).toBe(false);
    expect(continueText).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBe(true);
    expect(createCandidate).toHaveBeenCalledWith({ chapter: '章节A.md', original: '', proposed: '续写文本', instruction: '续写', kind: 'append' });
  });

  it('块2·④：done 带 voice 时候选项带 voiceNote（flags 空或缺失不带）', async () => {
    const flags = ['对白占比 40% → 10%', '平均句长 10 → 24 字'];
    let release!: () => void;
    const continueText = vi.fn().mockImplementation((_body: unknown, h: { onText: (text: string) => void; onDone?: (done: { text: string; voice?: { flags: string[] } }) => void }) =>
      new Promise<void>((resolve) => {
        release = () => { h.onDone?.({ text: '续写文本', voice: { flags } }); resolve(); };
      }),
    );
    const createCandidate = vi.fn().mockResolvedValue({ candidate: { ...CAND, kind: 'append', original: '', proposed: '续写文本', instruction: '续写' } });
    const store = new CandidatesStore();
    store.init(clientOf({ continueText, createCandidate }));
    work.init(clientOf(), 'C:/works/demo');
    work.current = { relPath: '章节A.md', title: '章节A', frontmatter: {}, frontmatterRaw: '', savedMd: '正文' };
    work.registerEditor({ getMd: () => '当前正文', applyEdit: () => 'ok', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });
    const p = store.continueFromChapter();
    release();
    expect(await p).toBe(true);
    expect(store.items[0]?.voiceNote).toEqual(flags);

    // voice 缺席（旧版 core / 降级）→ 无 voiceNote 字段
    const continueText2 = vi.fn().mockImplementation((_body: unknown, h: { onDone?: (done: { text: string }) => void }) =>
      Promise.resolve().then(() => { h.onDone?.({ text: '续写2' }); }),
    );
    const createCandidate2 = vi.fn().mockResolvedValue({ candidate: { ...CAND, id: 'c9', kind: 'append', original: '', proposed: '续写2', instruction: '续写' } });
    const store2 = new CandidatesStore();
    store2.init(clientOf({ continueText: continueText2, createCandidate: createCandidate2 }));
    await store2.continueFromChapter();
    expect(store2.items[0]?.voiceNote).toBeUndefined();
  });

  it('无当前章或正文为空不发请求；error 只报错不建候选', async () => {
    const continueText = vi.fn();
    const createCandidate = vi.fn();
    const client = clientOf({ continueText, createCandidate });
    const store = new CandidatesStore();
    store.init(client);
    expect(await store.continueFromChapter()).toBe(false);
    work.init(client, 'C:/works/demo');
    work.current = { relPath: '空.md', title: '空', frontmatter: {}, frontmatterRaw: '', savedMd: '  ' };
    expect(await store.continueFromChapter()).toBe(false);
    expect(continueText).not.toHaveBeenCalled();
    work.current = { ...work.current, savedMd: '正文' };
    store.init(clientOf({ continueText: vi.fn().mockImplementation(async (_b: unknown, h: { onError?: (err: Error) => void }) => h.onError?.(new Error('服务端错误'))), createCandidate }));
    expect(await store.continueFromChapter()).toBe(false);
    expect(work.error).toContain('AI 续写失败');
    expect(createCandidate).not.toHaveBeenCalled();
  });
});

describe('CandidatesStore · 批量采纳部分失败不中断（逐条收集 + 总是重拉）', () => {
  it('adoptSelected：第二条 patch 失败 → 第一条已 adopted、列表已重拉、error 含失败计数', async () => {
    const patchCandidate = vi.fn((id: string) => {
      if (id === 'c2') return Promise.reject(new Error('DB lock'));
      return Promise.resolve({ candidate: CAND });
    });
    const listCandidates = vi.fn().mockResolvedValue({ candidates: [] });
    const callTool = vi.fn().mockResolvedValue(undefined); // save + 后台刷树 + ledger_diagnostics 空
    const client = clientOf({ patchCandidate, listCandidates, callTool });
    const store = new CandidatesStore();
    store.init(client);
    work.init(client, 'C:/works/demo');
    work.current = { relPath: '章节A.md', title: '章节A', frontmatter: {}, frontmatterRaw: '---\n---\n', savedMd: 'x' };
    work.registerEditor({ getMd: () => 'x', applyEdit: () => 'ok', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });

    store.items = [CAND, { ...CAND, id: 'c2' }]; // 两条同章，锚点都 ok
    store.toggleSelect('c1');
    store.toggleSelect('c2');
    await store.adoptSelected();
    // 成功的照常 adopted（不整批中断/回滚）
    expect(patchCandidate).toHaveBeenCalledWith('c1', { status: 'adopted' });
    expect(patchCandidate).toHaveBeenCalledWith('c2', { status: 'adopted' }); // 失败的也尝试了落库
    // 部分失败：error 文案含失败条数与首错原因
    expect(work.error).toContain('部分候选未能采纳');
    expect(work.error).toContain('落库失败 1 条');
    expect(work.error).toContain('DB lock');
    // 即便部分失败也总是重拉列表 + 清选择 + 复位 busy
    expect(listCandidates).toHaveBeenCalledWith({ status: 'pending' });
    expect(store.selected.size).toBe(0);
    expect(store.busy).toBe(false);
  });
});

describe('CandidatesStore · 取消管道（续写 / 流式生成 / 批量整改）', () => {
  it('continueFromChapter：abortContinue 取消 → signal 中止、continuing 复位、迟到完成也不落候选不报错', async () => {
    const signals: AbortSignal[] = [];
    let finish!: () => void;
    // 模拟 postSse 的取消语义：abort 后流干净收尾（正常 resolve，无 error）
    const continueText = vi.fn().mockImplementation((_b: unknown, _h: unknown, signal?: AbortSignal) => {
      signals.push(signal!);
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    const createCandidate = vi.fn();
    const store = new CandidatesStore();
    store.init(clientOf({ continueText, createCandidate }));
    work.current = { relPath: '章节A.md', title: '章节A', frontmatter: {}, frontmatterRaw: '', savedMd: '正文' };
    work.registerEditor({ getMd: () => '当前正文', applyEdit: () => 'ok', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });

    const p = store.continueFromChapter();
    expect(store.continuing).toBe(true);
    expect(signals[0]).toBeInstanceOf(AbortSignal); // 续写请求已接 signal
    store.abortContinue();
    finish(); // 迟到完成：abort 后流才收尾
    expect(await p).toBe(false);
    expect(signals[0]!.aborted).toBe(true);
    expect(store.continuing).toBe(false); // 取消释放锁死
    expect(createCandidate).not.toHaveBeenCalled(); // 取消后不落候选
    expect(work.error).toBeNull(); // 取消不算失败，不打红条
    // 复位后可再次发起（不再永久锁死）
    const p2 = store.continueFromChapter();
    expect(store.continuing).toBe(true);
    expect(continueText).toHaveBeenCalledTimes(2);
    store.abortContinue();
    finish();
    expect(await p2).toBe(false);
  });

  it('createFromSelection：abortGenerate 取消 → 不落候选、无红条、generating 复位', async () => {
    const signals: AbortSignal[] = [];
    let finish!: () => void;
    const rewriteStream = vi.fn().mockImplementation((_b: unknown, _h: RewriteStreamHandlers, signal?: AbortSignal) => {
      signals.push(signal!);
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    const createCandidate = vi.fn();
    const store = new CandidatesStore();
    store.init(clientOf({ rewriteStream, createCandidate }));

    const p = store.createFromSelection('章节A.md', '原文X', '润色');
    expect(store.generating).not.toBeNull();
    store.abortGenerate();
    finish();
    expect(await p).toBe(false);
    expect(signals[0]!.aborted).toBe(true);
    expect(store.generating).toBeNull();
    expect(createCandidate).not.toHaveBeenCalled();
    expect(work.error).toBeNull();
  });

  it('rectifyTargets：单条整改失败逐条可见、不阻塞其余条目、busy 正常复位', async () => {
    let calls = 0;
    const rewriteStream = vi.fn().mockImplementation(async (_b: unknown, h: RewriteStreamHandlers) => {
      calls += 1;
      if (calls === 1) {
        h.onError?.(new Error('输出护栏拒绝'));
        return;
      }
      h.onDelta?.('整改后文本');
      h.onDone?.({ text: '整改后文本' });
    });
    const patchCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const client = clientOf({ rewriteStream, patchCandidate });
    const store = new CandidatesStore();
    store.init(client);
    store.items = [CAND, { ...CAND, id: 'c2' }];
    store.toggleSelect('c1');
    store.toggleSelect('c2');
    await store.rectifySelected('换成爽文节奏');
    expect(calls).toBe(2); // 第 1 条失败后第 2 条照常发起
    expect(patchCandidate).toHaveBeenCalledTimes(1);
    expect(patchCandidate).toHaveBeenCalledWith('c2', { proposed: '整改后文本', instruction: '润色 / 整改：换成爽文节奏' });
    expect(work.error).toContain('第 1 条整改失败');
    expect(work.error).toContain('输出护栏拒绝');
    expect(store.items[0]?.proposed).toBe('改写X'); // 失败条目保留原 proposed
    expect(store.items[1]?.proposed).toBe('整改后文本'); // 成功条目照常更新
    expect(store.busy).toBe(false);
    expect(store.rectifying).toBe(false);
  });

  it('rectifyTargets：abortRectify 取消 → 剩余条目不再发起、在飞条目不落库、busy 复位', async () => {
    const signals: AbortSignal[] = [];
    let release!: (h: RewriteStreamHandlers) => void;
    const rewriteStream = vi.fn().mockImplementation((_b: unknown, h: RewriteStreamHandlers, signal?: AbortSignal) => {
      signals.push(signal!);
      if (signals.length === 1) {
        return new Promise<void>((resolve) => { release = (hh) => { hh.onDone?.({ text: '部分文本' }); resolve(); }; });
      }
      return Promise.resolve();
    });
    const patchCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const client = clientOf({ rewriteStream, patchCandidate });
    const store = new CandidatesStore();
    store.init(client);
    store.items = [CAND, { ...CAND, id: 'c2' }];
    store.toggleSelect('c1');
    store.toggleSelect('c2');

    const p = store.rectifySelected('加细节');
    expect(store.rectifying).toBe(true);
    store.abortRectify(); // 第 1 条仍在飞时取消
    release({ onDelta: () => {}, onDone: () => {} }); // 迟到完成
    await p;
    expect(signals[0]!.aborted).toBe(true);
    expect(rewriteStream).toHaveBeenCalledTimes(1); // 第 2 条未发起
    expect(patchCandidate).not.toHaveBeenCalled(); // 在飞条目取消后不落库
    expect(store.busy).toBe(false);
    expect(store.rectifying).toBe(false);
  });

  it('abortContinue / abortRectify 无在飞任务时安全 no-op', () => {
    const store = new CandidatesStore();
    store.init(clientOf());
    expect(() => store.abortContinue()).not.toThrow();
    expect(() => store.abortGenerate()).not.toThrow();
    expect(() => store.abortRectify()).not.toThrow();
  });
});
