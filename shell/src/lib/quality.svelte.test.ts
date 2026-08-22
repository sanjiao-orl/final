// quality.svelte.ts 单测：run 成功写结果 / 失败写 error / close 复位 / 代际防竞态。
import { describe, expect, it, vi } from 'vitest';
import type { CoreClient } from './core.js';
import type { QualityFinding } from './types.js';
import { QualityStore } from './quality.svelte.js';

const FINDINGS: QualityFinding[] = [
  { kind: 'typo', quote: '他门口站着', reason: '疑似错别字：门→们', suggestion: '他们门口站着', line: 5, paraLine: 4, located: true },
  { kind: 'sensitive', quote: '某词', reason: '命中敏感词', line: 12, paraLine: 10, located: false },
];

function clientOf(overrides: Record<string, unknown> = {}): CoreClient {
  return {
    qualityCheck: vi.fn().mockResolvedValue({ ok: true, chapterTitle: '第一章', truncated: false, findings: FINDINGS }),
    ...overrides,
  } as unknown as CoreClient;
}

describe('QualityStore', () => {
  it('run 成功：打开面板、写 findings/chapterTitle、checking 复位', async () => {
    const qualityCheck = vi.fn().mockResolvedValue({ ok: true, chapterTitle: '第一章', truncated: false, findings: FINDINGS });
    const store = new QualityStore();
    store.init(clientOf({ qualityCheck }));
    await store.run('C:/works/demo', 'manuscript/第一章.md');
    expect(qualityCheck).toHaveBeenCalledWith('C:/works/demo', 'manuscript/第一章.md');
    expect(store.open).toBe(true);
    expect(store.checking).toBe(false);
    expect(store.result).toEqual(FINDINGS);
    expect(store.chapterTitle).toBe('第一章');
    expect(store.truncated).toBe(false);
    expect(store.error).toBeNull();
  });

  it('run 成功：truncated=true 与空 findings（未发现风险）原样落状态', async () => {
    const store = new QualityStore();
    store.init(clientOf({ qualityCheck: vi.fn().mockResolvedValue({ ok: true, truncated: true, findings: [] }) }));
    await store.run('C:/works/demo', 'a.md');
    expect(store.truncated).toBe(true);
    expect(store.result).toEqual([]);
    expect(store.error).toBeNull();
  });

  it('run 失败：error 写入、result 清空、不抛出', async () => {
    const store = new QualityStore();
    store.init(clientOf({ qualityCheck: vi.fn().mockRejectedValue(new Error('LLM 超时')) }));
    await store.run('C:/works/demo', 'a.md');
    expect(store.open).toBe(true);
    expect(store.checking).toBe(false);
    expect(store.error).toContain('LLM 超时');
    expect(store.result).toBeNull();
  });

  it('close：复位 open/result/error/chapterTitle/truncated，在飞读回作废', async () => {
    let release!: (v: unknown) => void;
    const qualityCheck = vi
      .fn()
      .mockImplementation(() => new Promise((r) => (release = r))); // 挂起模拟长请求
    const store = new QualityStore();
    store.init(clientOf({ qualityCheck }));
    const p = store.run('C:/works/demo', 'a.md');
    expect(store.checking).toBe(true);
    store.close(); // 用户中途关面板
    expect(store.open).toBe(false);
    expect(store.checking).toBe(false);
    release({ ok: true, findings: FINDINGS }); // 迟到的成功读回：按代际丢弃
    await p;
    expect(store.result).toBeNull();
    expect(store.chapterTitle).toBeNull();
  });

  it('连点两次质检：先发的旧读回不覆盖新章现场（代际防竞态）', async () => {
    const pending: Array<(v: unknown) => void> = [];
    const qualityCheck = vi
      .fn()
      .mockImplementation(() => new Promise((r) => pending.push(r)));
    const store = new QualityStore();
    store.init(clientOf({ qualityCheck }));
    const p1 = store.run('C:/works/demo', 'A.md');
    const p2 = store.run('C:/works/demo', 'B.md'); // 立刻点另一章
    pending[1]!({ ok: true, chapterTitle: 'B', findings: [] }); // B 先回
    await p2;
    pending[0]!({ ok: true, chapterTitle: 'A', findings: FINDINGS }); // A 的旧读回后到
    await p1;
    expect(qualityCheck).toHaveBeenNthCalledWith(1, 'C:/works/demo', 'A.md');
    expect(qualityCheck).toHaveBeenNthCalledWith(2, 'C:/works/demo', 'B.md');
    expect(store.chapterTitle).toBe('B'); // 停在后点章的现场
    expect(store.result).toEqual([]);
    expect(store.checking).toBe(false); // 只有最新一代复位 checking，不被旧读回干扰
  });
});
