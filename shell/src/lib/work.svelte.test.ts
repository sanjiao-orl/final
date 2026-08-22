// work.svelte.ts 单测：结构树/开章（脏保存门禁）/保存/删除/导出/编辑入口/重命名 title 同步/回收站
// + 码字落账（任务 1b fire-and-forget）/章发布状态流转（任务 2b）/日历数据（1d）/平台格式复制（3b）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreClient } from './core.js';
import type { ChapterNode, VolumeNode } from './types.js';
import { WorkStore } from './work.svelte.js';

// 剪贴板模块整体 mock：copyChapterText 的插件/回落分支归 clipboard.test.ts 管，这里只验 store 调用链
vi.mock('./clipboard.js', () => ({ writeClipboardText: vi.fn() }));
import { writeClipboardText } from './clipboard.js';

const clipWrite = vi.mocked(writeClipboardText);

function ch(relPath: string, title: string, wordCount = 100): ChapterNode {
  return { type: 'chapter', title, relPath, wordCount, scenes: [{ type: 'scene', title: '场景一', line: 3 }] };
}

const VOLUME: VolumeNode[] = [{ type: 'volume', title: '第一卷', children: [ch('第一卷/第一章.md', '第一章')] }];

const READ_RESULT = { content: '正文', frontmatter: {}, frontmatterRaw: '---\nfoo: 1\n---\n', body: '正文' };

/** list_trash 返回的条目样例（契约镜像）。 */
const TRASH_ENTRY = {
  trashPath: '.novel/trash/第一卷__第一章-x.md',
  kind: 'chapter' as const,
  originalPath: '第一卷/第一章.md',
  deletedAt: '2026-08-12T10:00:00Z',
  name: '第一章-x.md',
};

function mockClient(overrides: Record<string, unknown> = {}): CoreClient {
  return {
    callTool: vi.fn(),
    // saveCurrent 成功后 fire-and-forget 落账（任务 1b）：mock 缺它会被当同步异常吞进「保存失败」
    recordStatsSnapshot: vi.fn().mockResolvedValue({ date: '2026-08-12', words: 100, prev: null, delta: null }),
    getDailyStats: vi.fn().mockResolvedValue({ days: [] }),
    ...overrides,
  } as unknown as CoreClient;
}

// node 测试环境无 localStorage；work.svelte.ts 的 trash helpers 走 localStorage，polyfill 一个最小可写实现
const _store = new Map<string, string>();
const _localStorage = {
  getItem: (k: string): string | null => _store.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    _store.set(k, v);
  },
  removeItem: (k: string): void => {
    _store.delete(k);
  },
  clear: (): void => {
    _store.clear();
  },
  key: (i: number): string | null => [..._store.keys()][i] ?? null,
  get length(): number {
    return _store.size;
  },
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => _localStorage });

beforeEach(() => {
  _store.clear();
  clipWrite.mockReset();
});

describe('WorkStore', () => {
  it('loadStructure：调 list_structure 代理并落 structure', async () => {
    const client = mockClient({ callTool: vi.fn().mockResolvedValue(VOLUME) });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.loadStructure();
    expect(work.structure).toEqual(VOLUME);
    expect(client.callTool).toHaveBeenCalledWith('list_structure', { workDir: 'C:/works/demo' });
    expect(work.workName).toBe('demo');
  });

  it('openChapter：read_chapter 填充 current/pendingScene/currentScene，dirty 复位', async () => {
    const client = mockClient({ callTool: vi.fn().mockResolvedValue(READ_RESULT) });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!, '场景一');
    expect(work.current?.relPath).toBe('第一卷/第一章.md');
    expect(work.current?.frontmatterRaw).toBe('---\nfoo: 1\n---\n');
    expect(work.current?.savedMd).toBe('正文');
    expect(work.pendingScene).toBe('场景一');
    expect(work.currentScene).toBe('场景一');
    expect(work.dirty).toBe(false);
  });

  it('openChapter 无场景标题：currentScene 也清空（只有重开场景才设）', async () => {
    const client = mockClient({ callTool: vi.fn().mockResolvedValue(READ_RESULT) });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    expect(work.pendingScene).toBeNull();
    expect(work.currentScene).toBeNull();
  });

  it('openChapter 带未保存改动：先自动落盘再切章', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(READ_RESULT) // 第一章 read
      .mockResolvedValueOnce(undefined) // write_chapter（保存脏数据）
      .mockResolvedValueOnce(VOLUME) // saveCurrent 内部的 void loadStructure 后台刷树
      .mockResolvedValueOnce({ ...READ_RESULT, body: '第二章正文' }); // 第二章 read
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    work.registerEditor({ getMd: () => '改过的正文', applyEdit: () => 'not-found', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });
    work.dirty = true;
    await work.openChapter(ch('第一卷/第二章.md', '第二章'));
    // 保存调用：content = frontmatterRaw + 编辑器序列化
    expect(callTool).toHaveBeenNthCalledWith(2, 'write_chapter', {
      workDir: 'C:/works/demo',
      relPath: '第一卷/第一章.md',
      content: '---\nfoo: 1\n---\n改过的正文',
    });
    expect(work.current?.relPath).toBe('第一卷/第二章.md');
    expect(work.dirty).toBe(false);
  });

  it('reloadCurrent：跳过脏保存门禁，以磁盘内容刷新 current 并 bump reloadNonce', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(READ_RESULT) // openChapter 的 read_chapter
      .mockResolvedValueOnce({ ...READ_RESULT, body: '磁盘新文' }); // reloadCurrent 的 read_chapter
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    work.registerEditor({ getMd: () => '旧编辑器文', applyEdit: () => 'not-found', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });
    work.dirty = true;
    await work.reloadCurrent();
    expect(callTool).toHaveBeenCalledTimes(2); // 只重读，不写回旧编辑器内容
    expect(callTool).toHaveBeenLastCalledWith('read_chapter', {
      workDir: 'C:/works/demo',
      relPath: '第一卷/第一章.md',
    });
    expect(work.current?.savedMd).toBe('磁盘新文');
    expect(work.dirty).toBe(false);
    expect(work.reloadNonce).toBe(1);
  });

  it('openChapter 失败：显式报错，不切章', async () => {
    const client = mockClient({ callTool: vi.fn().mockRejectedValue(new Error('文件不存在')) });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    expect(work.current).toBeNull();
    expect(work.error).toContain('打开章节失败');
    expect(work.error).toContain('文件不存在');
  });

  it('saveCurrent：拼接 frontmatter + 编辑器 md 落盘，成功后 dirty 复位、后台刷树', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(READ_RESULT)
      .mockResolvedValueOnce(undefined) // write_chapter
      .mockResolvedValueOnce(VOLUME); // 后台 loadStructure
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    work.registerEditor({ getMd: () => '编辑器正文', applyEdit: () => 'not-found', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });
    work.dirty = true;
    const ok = await work.saveCurrent();
    expect(ok).toBe(true);
    expect(callTool).toHaveBeenNthCalledWith(2, 'write_chapter', {
      workDir: 'C:/works/demo',
      relPath: '第一卷/第一章.md',
      content: '---\nfoo: 1\n---\n编辑器正文',
    });
    expect(work.dirty).toBe(false);
    expect(work.current?.savedMd).toBe('编辑器正文');
    await new Promise((r) => setTimeout(r, 0));
    expect(work.structure).toEqual(VOLUME); // 后台刷树生效
  });

  it('saveCurrent 失败：红条 + 脏标记保留', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(READ_RESULT)
      .mockRejectedValueOnce(new Error('磁盘已满'));
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    work.registerEditor({ getMd: () => '编辑器正文', applyEdit: () => 'not-found', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });
    work.dirty = true;
    const ok = await work.saveCurrent();
    expect(ok).toBe(false);
    expect(work.error).toContain('保存失败');
    expect(work.dirty).toBe(true); // 脏标记兜底不丢
  });

  it('deleteChapter：当前章软删 → 清 current、notice 提示、刷新结构并触发回收站重拉', async () => {
    const callTool = vi.fn((name: string) => {
      if (name === 'read_chapter') return Promise.resolve(READ_RESULT);
      if (name === 'delete_chapter') return Promise.resolve({ trashPath: 'C:/works/demo/.novel/trash/第一章.md' });
      if (name === 'list_trash') return Promise.resolve({ entries: [TRASH_ENTRY] });
      if (name === 'list_structure') return Promise.resolve(VOLUME);
      return Promise.resolve(undefined);
    });
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    work.dirty = true;
    await work.deleteChapter('第一卷/第一章.md');
    expect(work.current).toBeNull();
    expect(work.dirty).toBe(false);
    expect(work.notice).toContain('第一章.md');
    // 删除成功后 fire-and-forget 重拉回收站（domain list_trash 为真相源）
    expect(callTool).toHaveBeenCalledWith('list_trash', { workDir: 'C:/works/demo' });
    await new Promise((r) => setTimeout(r, 0));
    expect(work.trashEntries).toEqual([TRASH_ENTRY]);
    expect(work.structure).toEqual(VOLUME);
  });

  it('exportAll：成功 notice 带章数；失败红条', async () => {
    const okClient = mockClient({ callTool: vi.fn().mockResolvedValue({ path: 'C:/works/demo/全稿.txt', chapters: 3 }) });
    const work = new WorkStore();
    work.init(okClient, 'C:/works/demo');
    await work.exportAll();
    expect(work.notice).toContain('3 章');
    expect(work.notice).toContain('全稿.txt');

    const failClient = mockClient({ callTool: vi.fn().mockRejectedValue(new Error('导出被拒')) });
    const work2 = new WorkStore();
    work2.init(failClient, 'C:/works/demo');
    await work2.exportAll();
    expect(work2.error).toContain('导出失败');
  });

  it('applyEdit / appendMd / replaceBodyMd / whenEditorReady：未注册返回 no-editor，注册后走编辑入口', async () => {
    const client = mockClient();
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    expect(work.applyEdit('a', 'b')).toBe('no-editor');
    expect(work.appendMd('y')).toBe('no-editor');
    expect(work.replaceBodyMd('z')).toBe('no-editor');
    const ready = await work.whenEditorReady(50);
    expect(ready).toBe(false);
    work.registerEditor({
      getMd: () => 'x',
      applyEdit: (original: string) => (original === 'a' ? 'ok' : 'not-found'),
      appendMd: (md: string) => (md === 'y' ? 'ok' : 'not-found'),
      replaceBodyMd: (md: string) => (md === 'z' ? 'ok' : 'not-found'),
    });
    expect(await work.whenEditorReady(50)).toBe(true);
    expect(work.applyEdit('a', 'b')).toBe('ok');
    expect(work.appendMd('y')).toBe('ok');
    expect(work.replaceBodyMd('z')).toBe('ok');
    expect(work.appendMd('其他')).toBe('not-found');
    expect(work.replaceBodyMd('其他')).toBe('not-found');
    work.registerEditor(null);
    expect(work.applyEdit('a', 'b')).toBe('no-editor');
    expect(work.appendMd('y')).toBe('no-editor');
    expect(work.replaceBodyMd('z')).toBe('no-editor');
  });

  it('findChapter：按 relPath 命中/未命中', () => {
    const work = new WorkStore();
    work.structure = VOLUME;
    expect(work.findChapter('第一卷/第一章.md')?.title).toBe('第一章');
    expect(work.findChapter('不存在的章.md')).toBeNull();
  });

  it('loadStructure：失败进 work.error 并清 loading；throw 供上层感知', async () => {
    const client = mockClient({ callTool: vi.fn().mockRejectedValue(new Error('断网')) });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await expect(work.loadStructure()).rejects.toThrow('断网');
    expect(work.error).toContain('加载结构树失败');
    expect(work.error).toContain('断网');
    expect(work.loading).toBe(false);
  });

  it('loadStructure：loading 在请求期间为 true，落库后置回 false', async () => {
    let resolveLoad!: (v: VolumeNode[]) => void;
    const client = mockClient({
      callTool: vi.fn().mockImplementation(
        () =>
          new Promise<VolumeNode[]>((r) => {
            resolveLoad = r;
          }),
      ),
    });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    const p = work.loadStructure();
    expect(work.loading).toBe(true);
    resolveLoad(VOLUME);
    await p;
    expect(work.loading).toBe(false);
  });

  it('renameChapter：当前章被重命名 → current.title 同步刷新', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(READ_RESULT) // openChapter 的 read
      .mockResolvedValueOnce({ ok: true, relPath: '第一卷/第一章·少年.md' }) // rename_chapter
      .mockResolvedValueOnce(VOLUME); // loadStructure
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    expect(work.current?.title).toBe('第一章');
    const ok = await work.renameChapter('第一卷/第一章.md', '少年');
    expect(ok).toBe(true);
    expect(work.current?.title).toBe('少年');
    expect(work.current?.relPath).toBe('第一卷/第一章·少年.md');
  });

  it('refreshTrash：list_trash 写入 trashEntries，首次成功后清旧 localStorage 残留 key（一次性迁移清理）', async () => {
    const legacyKey = 'novel.trash.C:/works/demo';
    _store.set(legacyKey, JSON.stringify([{ relPath: '旧.md', trashPath: '.novel/trash/旧-x.md', deletedAt: Date.now() }]));
    const callTool = vi.fn((name: string) => {
      if (name === 'list_trash') {
        return Promise.resolve({ entries: [TRASH_ENTRY, { trashPath: '.novel/trash/junk', kind: 'volume', name: 'junk' }] });
      }
      return Promise.resolve(undefined);
    });
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    expect(work.trashEntries).toEqual([]);
    await work.refreshTrash();
    // domain 列表原样落状态（含无 originalPath/deletedAt 的无时间戳垃圾条目）
    expect(work.trashEntries).toHaveLength(2);
    expect(work.trashEntries[0]).toMatchObject({ originalPath: '第一卷/第一章.md' });
    expect(work.trashEntries[1]?.originalPath).toBeUndefined();
    // 迁移清理：壳侧旧跟踪数据与 domain 真相源可能不一致，首次 list_trash 成功后作废删除
    expect(_store.has(legacyKey)).toBe(false);
  });

  it('refreshTrash：list_trash 失败静默——不抛错、列表保持现状、console.warn 留痕；成功前不清旧 key', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const legacyKey = 'novel.trash.C:/works/demo';
    _store.set(legacyKey, '[]');
    const client = mockClient({ callTool: vi.fn().mockRejectedValue(new Error('core 是旧版没有 list_trash')) });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await expect(work.refreshTrash()).resolves.toBeUndefined(); // 失败静默不抛
    expect(work.trashEntries).toEqual([]);
    expect(_store.has(legacyKey)).toBe(true); // 未成功拉取不动旧数据
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('restoreTrash：读 trash → 按 originalPath 写回 → 重拉列表 → 刷结构', async () => {
    const trashContent = '---\nfoo: 1\n---\n旧章内容';
    const callTool = vi.fn().mockImplementation((name: string) => {
      if (name === 'read_chapter') return Promise.resolve({ content: trashContent }); // restore read_chapter on trash path
      if (name === 'write_chapter') return Promise.resolve(undefined);
      if (name === 'list_trash') return Promise.resolve({ entries: [] }); // 找回后重拉：条目已移出
      if (name === 'list_structure') return Promise.resolve(VOLUME);
      return Promise.resolve(undefined);
    });
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    work.trashEntries = [TRASH_ENTRY]; // 预置回收站状态（refreshTrash 已拉取过的现场）
    const ok = await work.restoreTrash('.novel/trash/第一卷__第一章-x.md');
    expect(ok).toBe(true);
    expect(work.notice).toContain('第一卷/第一章.md');
    expect(callTool).toHaveBeenCalledWith('read_chapter', {
      workDir: 'C:/works/demo',
      relPath: '.novel/trash/第一卷__第一章-x.md',
    });
    // 写回目标是 domain 给的 originalPath（不再是壳侧记录的 relPath）
    expect(callTool).toHaveBeenCalledWith('write_chapter', {
      workDir: 'C:/works/demo',
      relPath: '第一卷/第一章.md',
      content: trashContent,
    });
    expect(work.trashEntries).toEqual([]); // 重拉后条目已移出
    expect(work.structure).toEqual(VOLUME);
  });

  it('restoreTrash：trashPath 不在当前列表 → 报错返回 false', async () => {
    const client = mockClient();
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    const ok = await work.restoreTrash('.novel/trash/不存在.md');
    expect(ok).toBe(false);
    expect(work.error).toContain('回收站条目不存在');
  });

  it('restoreTrash：entry 无 originalPath（无时间戳垃圾）→ notice 提示手动处理并中断，不发读写调用', async () => {
    const callTool = vi.fn();
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    work.trashEntries = [{ trashPath: '.novel/trash/无名垃圾', kind: 'volume', name: '无名垃圾' }];
    const ok = await work.restoreTrash('.novel/trash/无名垃圾');
    expect(ok).toBe(false);
    expect(work.notice).toContain('该条目无法还原原路径');
    expect(work.notice).toContain('.novel/trash/');
    expect(callTool).not.toHaveBeenCalledWith('read_chapter', expect.anything());
    expect(callTool).not.toHaveBeenCalledWith('write_chapter', expect.anything());
  });

  it('restoreTrash：write_chapter 失败 → work.error 红条', async () => {
    const callTool = vi.fn((name: string) => {
      if (name === 'read_chapter') return Promise.resolve({ content: '---\n---\n旧' });
      return Promise.reject(new Error('写盘炸了'));
    });
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    work.trashEntries = [
      { trashPath: '.novel/trash/a-x.md', kind: 'chapter', originalPath: 'manuscript/a.md', deletedAt: '2026-08-12T10:00:00Z', name: 'a-x.md' },
    ];
    const ok = await work.restoreTrash('.novel/trash/a-x.md');
    expect(ok).toBe(false);
    expect(work.error).toContain('找回失败');
  });
});

describe('WorkStore · 开章/保存竞态（代际 + 快照）', () => {
  it('openChapter：并发连开两章，先发的读回落后被代际丢弃，current 停在最后点章', async () => {
    let resolveA!: (v: unknown) => void;
    const callTool = vi.fn((name: string) => {
      if (name === 'read_chapter') {
        // 第一次调用（A 章）挂起，稍后由 resolveA 回；第二次（B 章）立即回
        if (!resolveA) return new Promise((r) => (resolveA = r));
        return Promise.resolve({ ...READ_RESULT, body: 'B 章正文' });
      }
      return Promise.resolve(undefined);
    });
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    const pA = work.openChapter(ch('A.md', 'A章')); // 先点 A，读挂起
    const pB = work.openChapter(ch('B.md', 'B章')); // 后点 B，立即回
    await pB;
    expect(work.current?.relPath).toBe('B.md');
    resolveA({ content: 'A', frontmatter: {}, frontmatterRaw: '---\n---\n', body: 'A 章正文' }); // A 的旧读回此刻才到
    await pA;
    expect(work.current?.relPath).toBe('B.md'); // 仍是后点章，未被 A 覆盖
  });

  it('saveCurrent：写盘在途切章（current 已换）→ 旧章照常落盘，新章 dirty 不被误清', async () => {
    let resolveWrite!: (v: unknown) => void;
    const callTool = vi.fn((name: string) => {
      if (name === 'write_chapter') return new Promise((r) => (resolveWrite = r));
      if (name === 'list_structure') return Promise.resolve(VOLUME);
      return Promise.resolve(undefined);
    });
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    work.current = { relPath: 'A.md', title: 'A章', frontmatter: {}, frontmatterRaw: '---\nfoo: 1\n---\n', savedMd: 'A 旧文' };
    work.registerEditor({ getMd: () => 'A 的改动', applyEdit: () => 'not-found', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });
    work.dirty = true;
    const saveP = work.saveCurrent(); // A 写盘挂起
    // 保存在途：用户已切到 B 章（直接换 current，绕过 openChapter 脏保存门禁，只验 saveCurrent 快照语义）
    work.current = { relPath: 'B.md', title: 'B章', frontmatter: {}, frontmatterRaw: '---\n---\n', savedMd: 'B 旧文' };
    work.registerEditor({ getMd: () => 'B 的改动', applyEdit: () => 'not-found', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });
    work.dirty = true; // B 有脏
    resolveWrite(undefined);
    await saveP;
    // A 照常落盘（用 A 的快照 relPath/frontmatter）
    expect(callTool).toHaveBeenCalledWith('write_chapter', expect.objectContaining({
      relPath: 'A.md',
      content: '---\nfoo: 1\n---\nA 的改动',
    }));
    // B 的新章状态不被 A 的保存误清（savedMd 不变、dirty 保留）
    expect(work.current?.relPath).toBe('B.md');
    expect(work.current?.savedMd).toBe('B 旧文');
    expect(work.dirty).toBe(true);
  });

  it('saveCurrent 成功后 fire-and-forget 落账 recordStatsSnapshot(workDir)，不阻塞返回', async () => {
    const recordStatsSnapshot = vi.fn().mockResolvedValue({ date: '2026-08-12', words: 100, prev: null, delta: null });
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(READ_RESULT)
      .mockResolvedValueOnce(undefined) // write_chapter
      .mockResolvedValueOnce(VOLUME); // 后台 loadStructure
    const client = mockClient({ callTool, recordStatsSnapshot });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    work.dirty = true;
    const ok = await work.saveCurrent();
    expect(ok).toBe(true);
    // fire-and-forget：saveCurrent 返回前已发起（void 前台不 await），参数只有 workDir
    expect(recordStatsSnapshot).toHaveBeenCalledWith('C:/works/demo');
    expect(work.error).toBeNull();
    await new Promise((r) => setTimeout(r, 0)); // 放后台微任务跑完
  });

  it('recordStatsSnapshot 失败静默：不影响保存结果、不报红条、不打扰并发守卫', async () => {
    const recordStatsSnapshot = vi.fn().mockRejectedValue(new Error('core 断连'));
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(READ_RESULT)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(VOLUME);
    const client = mockClient({ callTool, recordStatsSnapshot });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    work.dirty = true;
    const ok = await work.saveCurrent();
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(recordStatsSnapshot).toHaveBeenCalledTimes(1);
    expect(work.error).toBeNull(); // 落账失败被吞，不污染保存现场
    expect(work.dirty).toBe(false);
  });

  it('cycleChapterStatus：无 status → 草稿，frontmatterRaw 开栏后插入 status 行并走 saveCurrent', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(READ_RESULT) // openChapter（frontmatterRaw 无 status）
      .mockResolvedValueOnce(undefined) // write_chapter
      .mockResolvedValue(VOLUME); // loadStructure
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    const ok = await work.cycleChapterStatus();
    expect(ok).toBe(true);
    expect(work.current?.frontmatterRaw).toBe('---\nstatus: 草稿\nfoo: 1\n---\n'); // 其余键字节级保留
    expect(work.current?.frontmatter).toMatchObject({ status: '草稿' });
    // 复用 saveCurrent 落盘：write_chapter 内容 = 新 frontmatterRaw + 正文
    expect(callTool).toHaveBeenCalledWith('write_chapter', {
      workDir: 'C:/works/demo',
      relPath: '第一卷/第一章.md',
      content: '---\nstatus: 草稿\nfoo: 1\n---\n正文',
    });
  });

  it('cycleChapterStatus：三态回环逐档推进（草稿→已发布→已校对→草稿），只改 status 行', async () => {
    const callTool = vi.fn().mockResolvedValue(undefined).mockResolvedValue(VOLUME);
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    work.current = {
      relPath: 'A.md',
      title: 'A章',
      frontmatter: { status: '草稿' },
      frontmatterRaw: '---\ntitle: A\nstatus: 草稿\n---\n',
      savedMd: 'v',
    };
    work.registerEditor({ getMd: () => 'v', applyEdit: () => 'not-found', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });
    await work.cycleChapterStatus();
    expect(work.current?.frontmatterRaw).toBe('---\ntitle: A\nstatus: 已发布\n---\n');
    await work.cycleChapterStatus();
    expect(work.current?.frontmatterRaw).toBe('---\ntitle: A\nstatus: 已校对\n---\n');
    await work.cycleChapterStatus();
    expect(work.current?.frontmatterRaw).toBe('---\ntitle: A\nstatus: 草稿\n---\n');
    // 未知值也归草稿起步
    work.current!.frontmatter = { status: '完结' };
    work.current!.frontmatterRaw = '---\nstatus: 完结\n---\n';
    await work.cycleChapterStatus();
    expect(work.current?.frontmatterRaw).toBe('---\nstatus: 草稿\n---\n');
  });

  it('cycleChapterStatus：保存失败回滚 frontmatterRaw/frontmatter，pill 不显示未落盘的态', async () => {
    const callTool = vi.fn().mockRejectedValue(new Error('磁盘已满'));
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    work.current = {
      relPath: 'A.md',
      title: 'A章',
      frontmatter: { status: '已发布' },
      frontmatterRaw: '---\nstatus: 已发布\n---\n',
      savedMd: 'v',
    };
    const ok = await work.cycleChapterStatus();
    expect(ok).toBe(false);
    expect(work.current?.frontmatterRaw).toBe('---\nstatus: 已发布\n---\n'); // 回滚
    expect(work.current?.frontmatter).toMatchObject({ status: '已发布' });
    expect(work.error).toContain('保存失败');
  });

  it('cycleChapterStatus / copyChapterText：无当前章直接 false，不发任何工具调用', async () => {
    const callTool = vi.fn();
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    expect(await work.cycleChapterStatus()).toBe(false);
    expect(await work.copyChapterText()).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('dailyStats：代理 getDailyStats(workDir)', async () => {
    const getDailyStats = vi.fn().mockResolvedValue({ days: [{ date: '2026-08-12', words: 1200 }] });
    const client = mockClient({ getDailyStats });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await expect(work.dailyStats()).resolves.toEqual({ days: [{ date: '2026-08-12', words: 1200 }] });
    expect(getDailyStats).toHaveBeenCalledWith('C:/works/demo');
  });

  it('copyChapterText：export_chapter_text 参数正确，取 text 写剪贴板，成功返回 true', async () => {
    clipWrite.mockResolvedValue(undefined);
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(READ_RESULT) // openChapter
      .mockResolvedValueOnce({ title: '第一章', text: '第一章\n\n平台格式正文' }); // export_chapter_text（core 已 unwrap）
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    const ok = await work.copyChapterText();
    expect(ok).toBe(true);
    expect(callTool).toHaveBeenLastCalledWith('export_chapter_text', {
      workDir: 'C:/works/demo',
      relPath: '第一卷/第一章.md',
    });
    expect(clipWrite).toHaveBeenCalledWith('第一章\n\n平台格式正文'); // 是平台格式 text，不是原始 md
    expect(work.error).toBeNull();
  });

  it('copyChapterText：工具失败 → false + 可行动红条', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(READ_RESULT)
      .mockRejectedValueOnce(new Error('导出被拒'));
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    const ok = await work.copyChapterText();
    expect(ok).toBe(false);
    expect(clipWrite).not.toHaveBeenCalled();
    expect(work.error).toContain('复制失败');
    expect(work.error).toContain('导出被拒');
    expect(work.error).toContain('手动复制'); // 可行动提示
  });

  it('copyChapterText：剪贴板两级回落都失败 → false + 红条（不误报成功）', async () => {
    clipWrite.mockRejectedValue(new Error('剪贴板不可用（Tauri 插件与 Web Clipboard 均失败）'));
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(READ_RESULT)
      .mockResolvedValueOnce({ title: '第一章', text: '第一章\n\n正文' });
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    const ok = await work.copyChapterText();
    expect(ok).toBe(false);
    expect(clipWrite).toHaveBeenCalledTimes(1);
    expect(work.error).toContain('复制失败');
  });

  it('saveCurrent：并发调用等待在飞保存完成后重入，第二次脏保存不丢', async () => {
    const writes: Array<(v: unknown) => void> = [];
    const callTool = vi.fn((name: string) => {
      if (name === 'write_chapter') return new Promise((r) => writes.push(r));
      if (name === 'list_structure') return Promise.resolve(VOLUME);
      return Promise.resolve(undefined);
    });
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    work.current = { relPath: 'A.md', title: 'A章', frontmatter: {}, frontmatterRaw: '', savedMd: 'v1' };
    work.registerEditor({ getMd: () => 'v2', applyEdit: () => 'not-found', appendMd: () => 'ok', replaceBodyMd: () => 'ok' });
    work.dirty = true;
    const p1 = work.saveCurrent();
    const p2 = work.saveCurrent(); // 在飞时并发第二次：应等待 p1 完成后重入，不吞
    expect(writes).toHaveLength(1); // 第一次立即发起写盘
    writes[0]!(undefined); // 第一次写盘完成
    await p1;
    // p2 等 p1 完成后的重入是异步微任务，用 waitFor 等到第二次写盘发起
    await vi.waitFor(() => expect(writes).toHaveLength(2)); // 第二次重入后再写一次（脏内容落盘）
    writes[1]!(undefined);
    const ok2 = await p2;
    expect(ok2).toBe(true);
    expect(work.current?.savedMd).toBe('v2');
    expect(work.dirty).toBe(false);
  });
});
