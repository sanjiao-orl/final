// inbox.svelte.ts 单测：加载/勾选/全选、批量采纳与驳回（驳回理由必带、有意延后带卷锚）、扫描触达与读数。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreClient } from './core.js';
import { InboxStore, type InboxEntryVM } from './inbox.svelte.js';
import { work } from './work.svelte.js';

function entryOf(id: string, status: InboxEntryVM['status'] = 'pending'): InboxEntryVM {
  return {
    id,
    origin: 'scan',
    status,
    createdAt: '2026-09-05T00:00:00Z',
    ops: [{ action: 'ADD', targetKey: `P-S-0001-${id}`, rationale: '测试摘由' }],
    resolution: null,
    verify: null,
  };
}

function clientOf(overrides: Record<string, unknown> = {}): CoreClient {
  return {
    callTool: vi.fn().mockResolvedValue({ count: 0, entries: [] }),
    scanPromise: vi.fn().mockResolvedValue({ scannedChapters: 10, suspectChapters: 1, llmCalls: 1, inbox: { added: ['PR-9'], skipped: [] } }),
    ...overrides,
  } as unknown as CoreClient;
}

beforeEach(() => {
  work.workDir = 'C:/works/demo';
  work.error = '';
});

describe('InboxStore', () => {
  it('load 拉列表并只保留 pending 勾选', async () => {
    const store = new InboxStore();
    const entries = [entryOf('a'), entryOf('b', 'adopted'), entryOf('c')];
    store.init(clientOf({ callTool: vi.fn().mockResolvedValue({ count: 3, entries }) }));
    store.selected = new Set(['a', 'b']); // b 已 adopted，应被清出勾选
    await store.load();
    expect(store.entries.length).toBe(3);
    expect(store.pendingCount).toBe(2);
    expect([...store.selected]).toEqual(['a']);
  });

  it('decide 采纳：逐条调 inbox_decide 后重拉列表、清空勾选', async () => {
    const store = new InboxStore();
    const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => {
      if (_name === 'inbox_list') return { count: 0, entries: [] };
      return {};
    });
    store.init(clientOf({ callTool }));
    store.selected = new Set(['a', 'b']);
    await store.decide('adopt');
    const decideCalls = callTool.mock.calls.filter((c) => c[0] === 'inbox_decide');
    expect(decideCalls.length).toBe(2);
    expect(decideCalls[0]![1]).toMatchObject({ workDir: 'C:/works/demo', proposalId: 'a', decision: 'adopt' });
    expect(store.selected.size).toBe(0);
  });

  it('decide 驳回必带理由；有意延后透传 reanchorVolume', async () => {
    const store = new InboxStore();
    const callTool = vi.fn(async (name: string) => (name === 'inbox_list' ? { count: 0, entries: [] } : {}));
    store.init(clientOf({ callTool }));
    store.selected = new Set(['a']);
    await expect(store.decide('discard')).rejects.toThrow(/理由/);
    await store.decide('discard', '有意延后', '卷三');
    const decideCall = callTool.mock.calls.find((c) => c[0] === 'inbox_decide') as unknown as [string, Record<string, unknown>];
    expect(decideCall[1]).toMatchObject({ decision: 'discard', dismissReason: '有意延后', reanchorVolume: '卷三' });
  });

  it('批量部分失败：单条失败不中断批次，失败条保留勾选、成功条清出、错误可见', async () => {
    const store = new InboxStore();
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'inbox_list') return { count: 1, entries: [entryOf('b')] }; // b 裁决失败 → 服务端仍 pending
      if (args.proposalId === 'b') throw new Error('core 断连');
      return {};
    });
    store.init(clientOf({ callTool }));
    store.selected = new Set(['a', 'b']);
    await store.decide('adopt');
    const decideCalls = callTool.mock.calls.filter((c) => c[0] === 'inbox_decide');
    expect(decideCalls.length).toBe(2); // b 失败不中断，a 后续条目照常裁决
    expect([...store.selected]).toEqual(['b']);
    expect(work.error).toContain('批量裁决失败');
  });

  it('load 失败写 work.error，不再伪装成空收件箱', async () => {
    const store = new InboxStore();
    store.init(clientOf({ callTool: vi.fn(async () => { throw new Error('503 重连中'); }) }));
    await store.load();
    expect(work.error).toContain('收件箱加载失败');
    expect(store.entries).toEqual([]);
  });

  it('scan 失败写 work.error 并复位 scanning；传长超时口径', async () => {
    const store = new InboxStore();
    const scanPromise = vi.fn(async () => { throw new Error('请求超时'); });
    store.init(clientOf({ scanPromise, callTool: vi.fn(async () => ({ count: 0, entries: [] })) }));
    await store.scan();
    expect(scanPromise).toHaveBeenCalledWith('C:/works/demo', undefined, { timeoutMs: 600_000 });
    expect(work.error).toContain('补账扫描失败');
    expect(store.scanning).toBe(false);
  });

  it('busy 期间 toggle 冻结（批量裁决进行中勾选不脱节）', async () => {
    const store = new InboxStore();
    store.init(clientOf());
    store.busy = true;
    store.toggle('a');
    expect(store.selected.size).toBe(0);
    store.busy = false;
    store.toggle('a');
    expect(store.selected.size).toBe(1);
  });

  it('scan 调 scanPromise 并回填 lastScan 读数、重拉列表', async () => {
    const store = new InboxStore();
    const scanPromise = vi.fn().mockResolvedValue({ scannedChapters: 10, suspectChapters: 2, llmCalls: 2, inbox: { added: ['PR-1', 'PR-2'], skipped: ['PR-0'] } });
    store.init(clientOf({ scanPromise, callTool: vi.fn().mockResolvedValue({ count: 0, entries: [] }) }));
    await store.scan();
    expect(scanPromise).toHaveBeenCalledWith('C:/works/demo', undefined, { timeoutMs: 600_000 });
    expect(store.lastScan).toMatchObject({ suspectChapters: 2, added: 2, skipped: 1 });
  });

  it('selectAllPending 全选/再点清空', () => {
    const store = new InboxStore();
    store.init(clientOf());
    store.entries = [entryOf('a'), entryOf('b'), entryOf('c', 'discarded')];
    store.selectAllPending();
    expect(store.selectedCount).toBe(2);
    store.selectAllPending();
    expect(store.selectedCount).toBe(0);
  });
});
