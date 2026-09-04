// characters.svelte.ts 单测：加载/扫描读数/失败接红条（4.3 角色卡批）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreClient } from './core.js';
import { CharactersStore } from './characters.svelte.js';
import { work } from './work.svelte.js';

function clientOf(overrides: Record<string, unknown> = {}): CoreClient {
  return {
    callTool: vi.fn().mockResolvedValue({ count: 0, characters: [] }),
    scanCharacters: vi.fn().mockResolvedValue({ scannedChapters: 3, knownMentions: 5, unknownCandidates: 2, variantSuspects: 1, inbox: { added: ['PR-1', 'PR-2'], skipped: [] } }),
    ...overrides,
  } as unknown as CoreClient;
}

beforeEach(() => {
  work.workDir = 'C:/works/demo';
  work.error = '';
});

describe('CharactersStore', () => {
  it('load 拉角色卡列表', async () => {
    const store = new CharactersStore();
    const cards = [{ name: '克莱恩', aliases: ['世界'], role: '值夜者', states: [{ field: '位置', value: '贝克兰德', since: 'manuscript/第10章.md' }] }];
    store.init(clientOf({ callTool: vi.fn().mockResolvedValue({ count: 1, characters: cards }) }));
    await store.load();
    expect(store.count).toBe(1);
    expect(store.entries[0]!.states?.[0]!.value).toBe('贝克兰德');
  });

  it('load 失败写 work.error，不伪装空态', async () => {
    const store = new CharactersStore();
    store.init(clientOf({ callTool: vi.fn(async () => { throw new Error('503 重连中'); }) }));
    await store.load();
    expect(work.error).toContain('角色卡加载失败');
    expect(store.entries).toEqual([]);
  });

  it('scan 调 scanCharacters 回填 lastScan、重拉列表', async () => {
    const store = new CharactersStore();
    const scanCharacters = vi.fn().mockResolvedValue({ scannedChapters: 3, knownMentions: 5, unknownCandidates: 2, variantSuspects: 1, inbox: { added: ['PR-1', 'PR-2'], skipped: ['PR-0'] } });
    store.init(clientOf({ scanCharacters, callTool: vi.fn().mockResolvedValue({ count: 0, characters: [] }) }));
    await store.scan();
    expect(scanCharacters).toHaveBeenCalledWith('C:/works/demo', undefined);
    expect(store.lastScan).toMatchObject({ unknownCandidates: 2, variantSuspects: 1, added: 2, skipped: 1 });
  });

  it('scan 失败写 work.error 并复位 scanning', async () => {
    const store = new CharactersStore();
    const scanCharacters = vi.fn(async () => { throw new Error('请求超时'); });
    store.init(clientOf({ scanCharacters }));
    await store.scan();
    expect(work.error).toContain('角色补账扫描失败');
    expect(store.scanning).toBe(false);
  });
});
