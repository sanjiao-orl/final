// snapshot.svelte.ts 单测：B4 快照列表/还原/采纳 toast。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreClient } from './core.js';
import { SnapshotStore } from './snapshot.svelte.js';
import { work } from './work.svelte.js';

beforeEach(() => {
  work.error = null;
  work.notice = null;
  work.current = null;
  work.structure = [];
  work.dirty = false;
  work.reloadNonce = 0;
});

function mockClient(overrides: Record<string, unknown> = {}): CoreClient {
  return { callTool: vi.fn(), ...overrides } as unknown as CoreClient;
}

describe('SnapshotStore', () => {
  it('listForChapter：调 list_snapshots 并返回；失败回落空数组', async () => {
    const ok = mockClient({
      callTool: vi.fn().mockResolvedValue({
        snapshots: [{ path: '.novel/history/xxx/20260812-103000-000.md', timestamp: '20260812-103000-000' }],
      }),
    });
    const s = new SnapshotStore();
    s.init(ok, 'C:/works/demo');
    const list = await s.listForChapter('manuscript/a.md');
    expect(list).toHaveLength(1);
    expect(ok.callTool).toHaveBeenCalledWith('list_snapshots', {
      workDir: 'C:/works/demo',
      relPath: 'manuscript/a.md',
    });

    const fail = mockClient({ callTool: vi.fn().mockRejectedValue(new Error('x')) });
    const s2 = new SnapshotStore();
    s2.init(fail, 'C:/works/demo');
    expect(await s2.listForChapter('manuscript/a.md')).toEqual([]);
  });

  it('latestTime：取最新快照文件名时间戳段；无快照返回 null', async () => {
    const s = new SnapshotStore();
    s.init(mockClient({ callTool: vi.fn().mockResolvedValue({ snapshots: [] }) }), 'd');
    expect(await s.latestTime('manuscript/a.md')).toBeNull();

    const ok = mockClient({
      callTool: vi.fn().mockResolvedValue({
        snapshots: [{ path: '.novel/history/a/20260812-103000-abc.md', timestamp: '20260812-103000-abc' }],
      }),
    });
    const s2 = new SnapshotStore();
    s2.init(ok, 'd');
    expect(await s2.latestTime('manuscript/a.md')).toBe('20260812-103000');
  });

  it('restore：读快照 → 写回原章 → 当前开该章则重载 + 刷树 + notice', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, content: '旧内容' }) // read_snapshot
      .mockResolvedValueOnce(undefined) // write_chapter
      .mockResolvedValueOnce({ content: '旧内容', frontmatter: {}, frontmatterRaw: '', body: '旧内容' }) // reloadCurrent 的 read_chapter
      .mockResolvedValueOnce([]); // loadStructure
    const client = mockClient({ callTool });
    work.init(client, 'C:/works/demo');
    work.current = {
      relPath: 'manuscript/a.md',
      title: '第一章',
      frontmatterRaw: '',
      frontmatter: {},
      savedMd: '新内容',
    };
    work.dirty = true;
    work.structure = [
      {
        type: 'volume',
        title: '第一卷',
        children: [{ type: 'chapter', title: '第一章', relPath: 'manuscript/a.md', wordCount: 3, scenes: [] }],
      },
    ];
    const s = new SnapshotStore();
    s.init(client, 'C:/works/demo');
    const ok = await s.restore('manuscript/a.md', '.novel/history/a/20260812-103000-abc.md');
    expect(ok).toBe(true);
    expect(callTool).toHaveBeenNthCalledWith(1, 'read_snapshot', {
      workDir: 'C:/works/demo',
      snapshotPath: '.novel/history/a/20260812-103000-abc.md',
    });
    expect(callTool).toHaveBeenNthCalledWith(2, 'write_chapter', {
      workDir: 'C:/works/demo',
      relPath: 'manuscript/a.md',
      content: '旧内容',
    });
    // 缺陷 1：还原当前章后必须重读磁盘（旧实现 openChapter 同 relPath 早退，假绿）。
    expect(callTool).toHaveBeenNthCalledWith(3, 'read_chapter', {
      workDir: 'C:/works/demo',
      relPath: 'manuscript/a.md',
    });
    expect(callTool).toHaveBeenNthCalledWith(4, 'list_structure', { workDir: 'C:/works/demo' });
    expect(work.current?.savedMd).toBe('旧内容');
    expect(work.dirty).toBe(false);
    expect(work.reloadNonce).toBe(1);
    expect(work.notice).toContain('已还原');
  });

  it('restoreLatest：无快照 → 显式报错返回 false', async () => {
    const client = mockClient({ callTool: vi.fn().mockResolvedValue({ snapshots: [] }) });
    const s = new SnapshotStore();
    s.init(client, 'd');
    expect(await s.restoreLatest('manuscript/a.md')).toBe(false);
    expect(work.error).toContain('没有可还原的快照');
  });

  it('restore 失败：work.error 红条，返回 false', async () => {
    const client = mockClient({ callTool: vi.fn().mockRejectedValue(new Error('磁盘')) });
    const s = new SnapshotStore();
    s.init(client, 'd');
    expect(await s.restore('manuscript/a.md', 'x.md')).toBe(false);
    expect(work.error).toContain('还原失败');
  });

  it('showAdoptedToast：带最新快照时间，dismiss 清空', async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        snapshots: [{ path: '.novel/history/a/20260812-103000-abc.md', timestamp: '20260812-103000-abc' }],
      }),
    });
    const s = new SnapshotStore();
    s.init(client, 'd');
    await s.showAdoptedToast('已采纳 1 条', 'manuscript/a.md');
    expect(s.toast?.message).toBe('已采纳 1 条');
    expect(s.toast?.relPath).toBe('manuscript/a.md');
    expect(s.toast?.snapshotTime).toBe('20260812-103000');
    s.dismissToast();
    expect(s.toast).toBeNull();
  });

  it('preview：调 read_snapshot 取回快照原文；失败回落空串', async () => {
    const ok = mockClient({
      callTool: vi.fn().mockResolvedValue({ ok: true, content: '快照旧内容' }),
    });
    const s = new SnapshotStore();
    s.init(ok, 'C:/works/demo');
    const txt = await s.preview('.novel/history/a/20260812-103000-abc.md');
    expect(txt).toBe('快照旧内容');
    expect(ok.callTool).toHaveBeenCalledWith('read_snapshot', {
      workDir: 'C:/works/demo',
      snapshotPath: '.novel/history/a/20260812-103000-abc.md',
    });

    const fail = mockClient({ callTool: vi.fn().mockRejectedValue(new Error('x')) });
    const s2 = new SnapshotStore();
    s2.init(fail, 'C:/works/demo');
    expect(await s2.preview('x.md')).toBe('');
  });

  it('loadLedger：透传 ledger_read 入参并返回 ledger 视图', async () => {
    const client = mockClient({
      callTool: vi.fn().mockResolvedValue({
        ledger: {
          clock: [{ chapters: ['manuscript/a.md'], storyDay: '第1日' }],
          props: [],
          promises: [],
          knowledge: [],
          doNotReexplain: [],
          protect: [],
          tripwires: [],
        },
        path: '.novel/ledger.md',
      }),
    });
    const s = new SnapshotStore();
    s.init(client, 'C:/works/demo');
    const r = await s.loadLedger();
    expect(client.callTool).toHaveBeenCalledWith('ledger_read', { workDir: 'C:/works/demo' });
    expect(r.path).toBe('.novel/ledger.md');
    expect(r.ledger.clock).toHaveLength(1);
  });
});
