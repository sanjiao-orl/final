// notes.svelte.ts 单测：mock tauri invoke（参照 settings.svelte.test.ts 的写法），
// 覆盖 load 空文件 / debounce 自动保存 / flush 立即保存 / 路径拼接 / 非 Tauri 降级。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notes, noteRelPath, chapterNoteId } from './notes.svelte.js';

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => unknown;

/** 挂上 window.__TAURI_INTERNALS__.invoke mock；返回该 mock 以便断言调用。 */
function mockTauri(impl: InvokeFn): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke: fn } },
  });
  return fn;
}

beforeEach(() => {
  notes.content = '';
  notes.relPath = null;
  notes.dirty = false;
  notes.saving = false;
  notes.savedAt = 0;
  notes.error = null;
  notes.unavailable = false;
  // 清掉上一用例可能残留的防抖定时器（flush 顶部同步清定时器）
  void notes.flush();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('作者笔记 store', () => {
  it('load：read_note 返回空文件 → content 置空、relPath 就位', async () => {
    const invoke = mockTauri(async (cmd) => {
      if (cmd === 'read_note') return '';
      throw new Error(`unexpected ${cmd}`);
    });
    await notes.load('book.md');
    expect(invoke).toHaveBeenCalledWith('read_note', { relPath: 'book.md' });
    expect(notes.relPath).toBe('book.md');
    expect(notes.content).toBe('');
    expect(notes.unavailable).toBe(false);
  });

  it('load：read_note 带已有内容 → content 填回', async () => {
    mockTauri(async (cmd) => {
      if (cmd === 'read_note') return '作者私房话';
      throw new Error(`unexpected ${cmd}`);
    });
    await notes.load('chapters/ch-1.md');
    expect(notes.content).toBe('作者私房话');
    expect(notes.relPath).toBe('chapters/ch-1.md');
  });

  it('load：切文件前先 flush 旧笔记（脏内容落到旧 relPath）', async () => {
    const calls: string[] = [];
    const invoke = mockTauri(async (cmd, args) => {
      calls.push(cmd);
      if (cmd === 'read_note') return '';
      if (cmd === 'write_note') return undefined;
      throw new Error(`unexpected ${cmd} ${JSON.stringify(args)}`);
    });
    await notes.load('book.md');
    notes.setContent('第一版私房话');
    await notes.flush();
    expect(invoke).toHaveBeenCalledWith('write_note', {
      relPath: 'book.md',
      content: '第一版私房话',
    });
    calls.length = 0;
    await notes.load('chapters/ch-1.md');
    expect(invoke).toHaveBeenCalledWith('read_note', { relPath: 'chapters/ch-1.md' });
    expect(notes.relPath).toBe('chapters/ch-1.md');
  });

  it('setContent：置脏，防抖 500ms 后自动保存（提前不落盘）', async () => {
    vi.useFakeTimers();
    try {
      const invoke = mockTauri(async (cmd) => {
        if (cmd === 'write_note') return undefined;
        throw new Error(`unexpected ${cmd}`);
      });
      await notes.load('book.md');
      notes.setContent('hello');
      expect(notes.dirty).toBe(true);
      vi.advanceTimersByTime(499);
      expect(invoke).not.toHaveBeenCalledWith('write_note', expect.anything());
      vi.advanceTimersByTime(1);
      await vi.waitFor(() => expect(notes.dirty).toBe(false));
      expect(invoke).toHaveBeenCalledWith('write_note', {
        relPath: 'book.md',
        content: 'hello',
      });
      expect(notes.savedAt).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush：立即保存（清防抖），成功后清脏并记录 savedAt', async () => {
    const invoke = mockTauri(async (cmd) => {
      if (cmd === 'write_note') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    await notes.load('book.md');
    notes.setContent('x');
    await notes.flush();
    expect(invoke).toHaveBeenCalledWith('write_note', { relPath: 'book.md', content: 'x' });
    expect(notes.dirty).toBe(false);
    expect(notes.saving).toBe(false);
    expect(notes.savedAt).toBeGreaterThan(0);
  });

  it('flush：未脏时不落盘（切换文件/收起前不空写）', async () => {
    const invoke = mockTauri(async (cmd) => {
      if (cmd === 'read_note') return '';
      throw new Error(`不该被调用: ${cmd}`);
    });
    await notes.load('book.md');
    await notes.flush();
    expect(invoke).not.toHaveBeenCalledWith('write_note', expect.anything());
  });

  it('flush 失败：保留脏标记并记 error（下次可重试）', async () => {
    mockTauri(async () => {
      throw new Error('磁盘写失败');
    });
    await notes.load('book.md');
    notes.setContent('y');
    await notes.flush();
    expect(notes.dirty).toBe(true);
    expect(notes.error).toContain('保存笔记失败');
    expect(notes.error).toContain('磁盘写失败');
  });

  it('路径拼接：全书=book.md；本章=chapters/<id>.md；兜底 id 剥掉 .md 避免双扩展名', () => {
    expect(noteRelPath('book', 'whatever')).toBe('book.md');
    expect(noteRelPath('chapter', 'ch-42')).toBe('chapters/ch-42.md');
    // 兜底 id（encodeURIComponent(relPath)）也要拼进文件名
    expect(noteRelPath('chapter', 'manuscript%2F第一卷%2F第1章')).toBe(
      'chapters/manuscript%2F第一卷%2F第1章.md',
    );
    // frontmatter 稳定 id 优先
    expect(chapterNoteId({ id: 'ch-7', relPath: 'manuscript/x.md' })).toBe('ch-7');
    // 无 id：encodeURIComponent(relPath) 兜底，剥掉尾部 .md（防双扩展名）
    expect(chapterNoteId({ relPath: 'manuscript/第一卷/第1章.md' })).toBe(
      'manuscript%2F%E7%AC%AC%E4%B8%80%E5%8D%B7%2F%E7%AC%AC1%E7%AB%A0',
    );
    expect(chapterNoteId(null)).toBeNull();
    expect(chapterNoteId(undefined)).toBeNull();
  });

  it('非 Tauri 环境：load 进 unavailable 态（不抛错），setContent 被忽略', async () => {
    await notes.load('book.md'); // 无 window.__TAURI_INTERNALS__（afterEach 已删）
    expect(notes.unavailable).toBe(true);
    expect(notes.content).toBe('');
    notes.setContent('不该进内存');
    expect(notes.content).toBe('');
    await notes.flush(); // 不抛错
  });
});

describe('作者笔记 store · flush 在途输入竞态', () => {
  it('flush：写盘在途时 setContent 追加 → flush 返回后 dirty 仍为 true（在途新输入不被误清）', async () => {
    let resolveWrite!: (v: unknown) => void;
    const invoke = mockTauri(async (cmd) => {
      if (cmd === 'read_note') return '';
      if (cmd === 'write_note') return new Promise((r) => (resolveWrite = r));
      throw new Error(`unexpected ${cmd}`);
    });
    await notes.load('book.md');
    notes.setContent('第一版');
    const p = notes.flush(); // 写盘挂起（快照 content='第一版'）
    notes.setContent('第一版＋在途追加'); // 写盘在途用户新敲（置 dirty）
    resolveWrite(undefined);
    await p;
    expect(notes.content).toBe('第一版＋在途追加');
    expect(notes.dirty).toBe(true); // 新输入未被误清，保持 dirty 让后续防抖再存
    expect(invoke).toHaveBeenCalledWith('write_note', { relPath: 'book.md', content: '第一版' });
  });
});
