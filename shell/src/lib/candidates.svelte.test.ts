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
    callTool: vi.fn().mockResolvedValue(undefined),
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

  it('选择逻辑：单选/全选/清空/计数；toggleDrawer 打开时加载', async () => {
    const client = clientOf();
    const store = new CandidatesStore();
    store.init(client);
    store.toggleDrawer();
    expect(store.drawerOpen).toBe(true);
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
      .mockResolvedValueOnce({ type: 'volume', title: '第一卷', children: [] }); // 后台刷树
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

describe('CandidatesStore · 采纳后自动诊断（批三-3）', () => {
  beforeEach(() => {
    snapshot.dismissNotice();
  });

  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  function adoptContext(overrides: Record<string, unknown> = {}): { store: CandidatesStore; callTool: ReturnType<typeof vi.fn> } {
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
      return Promise.resolve(undefined);
    });
    const client = clientOf({ patchCandidate, callTool, ...overrides });
    const store = new CandidatesStore();
    store.init(client);
    work.init(client, 'C:/works/demo');
    work.current = { relPath: '章节A.md', title: '章节A', frontmatter: {}, frontmatterRaw: '---\n---\n', savedMd: '原文X' };
    work.registerEditor({ getMd: () => '原文X改写X', applyEdit: () => 'ok', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });
    store.items = [CAND];
    store.toggleSelect('c1');
    return { store, callTool };
  }

  it('adoptSelected：采纳落定后诊断有 findings → 弹无还原动作的轻提示（含 MAJOR/BLOCKER 计数）', async () => {
    const { store, callTool } = adoptContext();
    await store.adoptSelected();
    await flush();
    expect(callTool).toHaveBeenCalledWith('ledger_diagnostics', {
      workDir: 'C:/works/demo',
      issueLogPath: 'editorial_notes/issues.md',
    });
    expect(snapshot.notice?.message).toContain('诊断现存 2 条');
    expect(snapshot.notice?.message).toContain('含 2 条 MAJOR/BLOCKER');
  });

  it('adoptSelected：诊断无 findings → 不弹提示（不打扰）', async () => {
    const { store } = adoptContext({
      callTool: vi.fn((name: string) => {
        if (name === 'ledger_diagnostics') return Promise.resolve({ findings: [], hasBlockers: false, blockerCount: 0 });
        return Promise.resolve(undefined);
      }),
    });
    await store.adoptSelected();
    await flush();
    expect(snapshot.notice).toBeNull();
  });

  it('adoptSelected：诊断调用失败 → 静默不弹提示', async () => {
    const { store } = adoptContext({
      callTool: vi.fn((name: string) => {
        if (name === 'ledger_diagnostics') return Promise.reject(new Error('core 掉线'));
        return Promise.resolve(undefined);
      }),
    });
    await store.adoptSelected();
    await flush();
    expect(snapshot.notice).toBeNull();
    expect(work.error).toBeNull(); // 不污染采纳主链路
  });
});
