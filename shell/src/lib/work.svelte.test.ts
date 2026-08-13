// work.svelte.ts 单测：结构树/开章（脏保存门禁）/保存/删除/导出/编辑入口/重命名 title 同步/回收站。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreClient } from './core.js';
import type { ChapterNode, VolumeNode } from './types.js';
import { WorkStore } from './work.svelte.js';

function ch(relPath: string, title: string, wordCount = 100): ChapterNode {
  return { type: 'chapter', title, relPath, wordCount, scenes: [{ type: 'scene', title: '场景一', line: 3 }] };
}

const VOLUME: VolumeNode[] = [{ type: 'volume', title: '第一卷', children: [ch('第一卷/第一章.md', '第一章')] }];

const READ_RESULT = { content: '正文', frontmatter: {}, frontmatterRaw: '---\nfoo: 1\n---\n', body: '正文' };

function mockClient(overrides: Record<string, unknown> = {}): CoreClient {
  return { callTool: vi.fn(), ...overrides } as unknown as CoreClient;
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
    work.registerEditor({ getMd: () => '改过的正文', applyEdit: () => 'not-found' });
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
    work.registerEditor({ getMd: () => '旧编辑器文', applyEdit: () => 'not-found' });
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
    work.registerEditor({ getMd: () => '编辑器正文', applyEdit: () => 'not-found' });
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
    work.registerEditor({ getMd: () => '编辑器正文', applyEdit: () => 'not-found' });
    work.dirty = true;
    const ok = await work.saveCurrent();
    expect(ok).toBe(false);
    expect(work.error).toContain('保存失败');
    expect(work.dirty).toBe(true); // 脏标记兜底不丢
  });

  it('deleteChapter：当前章软删 → 清 current、notice 提示、刷新结构', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(READ_RESULT)
      .mockResolvedValueOnce({ trashPath: 'C:/works/demo/.novel/trash/第一章.md' })
      .mockResolvedValueOnce(VOLUME);
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    work.dirty = true;
    await work.deleteChapter('第一卷/第一章.md');
    expect(work.current).toBeNull();
    expect(work.dirty).toBe(false);
    expect(work.notice).toContain('第一章.md');
    expect(callTool).toHaveBeenLastCalledWith('list_structure', { workDir: 'C:/works/demo' });
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

  it('applyEdit / whenEditorReady：未注册返回 no-editor，注册后走编辑入口', async () => {
    const client = mockClient();
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    expect(work.applyEdit('a', 'b')).toBe('no-editor');
    const ready = await work.whenEditorReady(50);
    expect(ready).toBe(false);
    work.registerEditor({
      getMd: () => 'x',
      applyEdit: (original: string) => (original === 'a' ? 'ok' : 'not-found'),
    });
    expect(await work.whenEditorReady(50)).toBe(true);
    expect(work.applyEdit('a', 'b')).toBe('ok');
    work.registerEditor(null);
    expect(work.applyEdit('a', 'b')).toBe('no-editor');
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

  it('deleteChapter：本地 trash 列表累积 trashPath（domain 无 list_trash 的兜底）', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ trashPath: '.novel/trash/第一卷__第一章-20260812-1.md' }) // delete_chapter
      .mockResolvedValueOnce(VOLUME); // loadStructure
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    expect(work.listTrash()).toEqual([]);
    await work.deleteChapter('第一卷/第一章.md');
    const entries = work.listTrash();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ relPath: '第一卷/第一章.md', trashPath: '.novel/trash/第一卷__第一章-20260812-1.md' });
  });

  it('restoreTrash：读 trash → 写回原路径 → 删 trash 条目 → 刷结构', async () => {
    const trashContent = '---\nfoo: 1\n---\n旧章内容';
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(READ_RESULT) // openChapter
      .mockResolvedValueOnce({ trashPath: '.novel/trash/第一卷__第一章-x.md' }) // delete
      .mockResolvedValueOnce(VOLUME) // loadStructure after delete
      .mockResolvedValueOnce({ content: trashContent }) // restore read_chapter on trash path
      .mockResolvedValueOnce(undefined) // restore write_chapter
      .mockResolvedValueOnce(VOLUME); // loadStructure after restore
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!);
    await work.deleteChapter('第一卷/第一章.md');
    expect(work.listTrash()).toHaveLength(1);
    const ok = await work.restoreTrash('.novel/trash/第一卷__第一章-x.md');
    expect(ok).toBe(true);
    expect(work.listTrash()).toEqual([]);
    expect(callTool).toHaveBeenCalledWith('read_chapter', {
      workDir: 'C:/works/demo',
      relPath: '.novel/trash/第一卷__第一章-x.md',
    });
    expect(callTool).toHaveBeenCalledWith('write_chapter', {
      workDir: 'C:/works/demo',
      relPath: '第一卷/第一章.md',
      content: trashContent,
    });
  });

  it('restoreTrash：trashPath 不存在 → 报错返回 false', async () => {
    const client = mockClient();
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    const ok = await work.restoreTrash('.novel/trash/不存在.md');
    expect(ok).toBe(false);
    expect(work.error).toContain('回收站条目不存在');
  });

  it('restoreTrash：write_chapter 失败 → work.error 红条', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ content: '---\n---\n旧' })
      .mockRejectedValueOnce(new Error('写盘炸了'));
    const client = mockClient({ callTool });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    // 预置 trash 条目
    _store.set(
      `novel.trash.${work.workDir}`,
      JSON.stringify([{ relPath: 'manuscript/a.md', trashPath: '.novel/trash/a-x.md', deletedAt: Date.now() }]),
    );
    const ok = await work.restoreTrash('.novel/trash/a-x.md');
    expect(ok).toBe(false);
    expect(work.error).toContain('找回失败');
  });
});
