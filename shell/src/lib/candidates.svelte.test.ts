// candidates.svelte.ts 单测：暂存区加载/选择、流式创建、批量采纳（同章/跨章/失败项）、整改、丢弃。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreClient, RewriteStreamHandlers } from './core.js';
import type { Candidate } from './types.js';
import { CandidatesStore } from './candidates.svelte.js';
import { work } from './work.svelte.js';

const CAND: Candidate = {
  id: 'c1',
  sessionId: null,
  chapter: '章节A.md',
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

  it('adoptSelected：同章逐条替换 → adopted 落库 → 保存 → 清选择', async () => {
    const patchCandidate = vi.fn().mockResolvedValue({ candidate: CAND });
    const callTool = vi.fn().mockResolvedValue(undefined); // write_chapter + 后台刷树
    const client = clientOf({ patchCandidate, callTool });
    const store = new CandidatesStore();
    store.init(client);
    work.init(client, 'C:/works/demo');
    work.current = { relPath: '章节A.md', title: '章节A', frontmatterRaw: '---\n---\n', savedMd: '原文X' };
    work.registerEditor({ getMd: () => '原文X改写X', applyEdit: () => 'ok' });

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
    work.current = { relPath: '章节A.md', title: '章节A', frontmatterRaw: '---\n---\n', savedMd: 'x' };
    work.registerEditor({ getMd: () => 'x', applyEdit: () => 'not-found' });

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
    work.current = { relPath: '章节B.md', title: '章节B', frontmatterRaw: '---\n---\n', savedMd: 'b' };
    work.structure = [{ type: 'volume', title: '第一卷', children: [{ type: 'chapter', title: '章节A', relPath: '章节A.md', wordCount: 1, scenes: [] }] }];
    work.registerEditor({ getMd: () => '其他正文改', applyEdit: () => 'ok' });

    store.items = [CAND];
    store.toggleSelect('c1');
    await store.adoptSelected();
    expect(callTool).toHaveBeenCalledWith('read_chapter', expect.objectContaining({ relPath: '章节A.md' }));
    expect(work.current?.relPath).toBe('章节A.md');
    expect(patchCandidate).toHaveBeenCalledWith('c1', { status: 'adopted' });
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
});
