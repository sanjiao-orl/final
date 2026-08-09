// work.svelte.ts 单测：结构树/开章（脏保存门禁）/保存/删除/导出/编辑入口。
import { describe, expect, it, vi } from 'vitest';
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

  it('openChapter：read_chapter 填充 current/pendingScene，dirty 复位', async () => {
    const client = mockClient({ callTool: vi.fn().mockResolvedValue(READ_RESULT) });
    const work = new WorkStore();
    work.init(client, 'C:/works/demo');
    await work.openChapter(VOLUME[0]!.children[0]!, '场景一');
    expect(work.current?.relPath).toBe('第一卷/第一章.md');
    expect(work.current?.frontmatterRaw).toBe('---\nfoo: 1\n---\n');
    expect(work.current?.savedMd).toBe('正文');
    expect(work.pendingScene).toBe('场景一');
    expect(work.dirty).toBe(false);
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
});
