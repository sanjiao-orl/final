// scheme.svelte.ts 单测（决策 0010）：posture 加载填充、激活/清除走 scheme_set_active 并重拉、三通道 persona 映射与空态。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreClient, PostureView } from './core.js';
import { SchemeStore } from './scheme.svelte.js';
import { work } from './work.svelte.js';

const POSTURE: PostureView = {
  personas: [
    { name: '外婆', description: '民间叙事', source: 'work' },
    { name: '刺猬', description: '冷峻职业', source: 'app' },
  ],
  schemes: [
    {
      name: '民间叙事',
      description: '口语化、重意象',
      channels: { chat: '外婆', rewrite: '外婆' },
      source: 'work',
    },
    {
      name: '冷峻职业',
      description: '简洁克制',
      channels: { review: '刺猬' },
      source: 'app',
    },
  ],
  activeScheme: '民间叙事',
};

function clientOf(overrides: Record<string, unknown> = {}): CoreClient {
  return {
    getPosture: vi.fn().mockResolvedValue(POSTURE),
    callTool: vi.fn().mockResolvedValue({ ok: true, active: '冷峻职业' }),
    ...overrides,
  } as unknown as CoreClient;
}

beforeEach(() => {
  work.workDir = '';
  work.error = null;
});

describe('SchemeStore', () => {
  it('load：无 workDir 不请求，降级为空态', async () => {
    const getPosture = vi.fn();
    const store = new SchemeStore();
    store.init(clientOf({ getPosture }));
    await store.load();
    expect(getPosture).not.toHaveBeenCalled();
    expect(store.personas).toEqual([]);
    expect(store.schemes).toEqual([]);
    expect(store.activeScheme).toBeNull();
  });

  it('load：有 workDir 拉 posture 填充 personas/schemes/activeScheme', async () => {
    const getPosture = vi.fn().mockResolvedValue(POSTURE);
    const store = new SchemeStore();
    store.init(clientOf({ getPosture }));
    work.workDir = 'C:/works/demo';
    await store.load();
    expect(getPosture).toHaveBeenCalledWith('C:/works/demo');
    expect(store.personas).toEqual(POSTURE.personas);
    expect(store.schemes).toEqual(POSTURE.schemes);
    expect(store.activeScheme).toBe('民间叙事');
  });

  it('load：拉取失败静默降级为空态（不抛、不污染 work.error）', async () => {
    const store = new SchemeStore();
    store.init(clientOf({ getPosture: vi.fn().mockRejectedValue(new Error('core 挂了')) }));
    work.workDir = 'C:/works/demo';
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.schemes).toEqual([]);
    expect(store.activeScheme).toBeNull();
    expect(work.error).toBeNull();
  });

  it('activate：激活方案调 scheme_set_active（name 原样），成功后重拉 posture', async () => {
    const callTool = vi.fn().mockResolvedValue({ ok: true, active: '冷峻职业' });
    const getPosture = vi.fn().mockResolvedValue({ ...POSTURE, activeScheme: '冷峻职业' });
    const store = new SchemeStore();
    store.init(clientOf({ callTool, getPosture }));
    work.workDir = 'C:/works/demo';
    await store.load();
    const ok = await store.activate('冷峻职业');
    expect(ok).toBe(true);
    expect(callTool).toHaveBeenCalledWith('scheme_set_active', {
      workDir: 'C:/works/demo',
      name: '冷峻职业',
    });
    expect(store.activeScheme).toBe('冷峻职业');
    expect(getPosture).toHaveBeenCalledTimes(2); // load + activate 后重拉
  });

  it('activate：null 清除回默认 → name 传空串，成功后 activeScheme 为空', async () => {
    const callTool = vi.fn().mockResolvedValue({ ok: true, active: null });
    const getPosture = vi.fn().mockResolvedValue({ ...POSTURE, activeScheme: null });
    const store = new SchemeStore();
    store.init(clientOf({ callTool, getPosture }));
    work.workDir = 'C:/works/demo';
    await store.load();
    store.activeScheme = '民间叙事';
    const ok = await store.activate(null);
    expect(ok).toBe(true);
    expect(callTool).toHaveBeenCalledWith('scheme_set_active', {
      workDir: 'C:/works/demo',
      name: '',
    });
    expect(store.activeScheme).toBeNull();
  });

  it('activate：core 拒绝（ok=false）→ 返回 false 并写 work.error，不重拉', async () => {
    const callTool = vi.fn().mockResolvedValue({ ok: false, active: null });
    const getPosture = vi.fn().mockResolvedValue(POSTURE);
    const store = new SchemeStore();
    store.init(clientOf({ callTool, getPosture }));
    work.workDir = 'C:/works/demo';
    await store.load(); // 首次拉 posture（1 次）
    const ok = await store.activate('不存在');
    expect(ok).toBe(false);
    expect(work.error).toContain('方案激活失败');
    expect(getPosture).toHaveBeenCalledTimes(1); // 拒绝后不重拉，仍只有首次那次
  });

  it('channelPersona：激活方案的 channels 三通道映射', async () => {
    const store = new SchemeStore();
    store.init(clientOf());
    work.workDir = 'C:/works/demo';
    await store.load(); // activeScheme='民间叙事' → chat/rewrite 有映射，review 无
    expect(store.channelPersona('chat')).toBe('外婆');
    expect(store.channelPersona('rewrite')).toBe('外婆');
    expect(store.channelPersona('review')).toBeNull();
  });

  it('channelPersona：无激活 / 激活方案不匹配 → null（请求体不带 persona）', async () => {
    const store = new SchemeStore();
    store.init(clientOf());
    work.workDir = 'C:/works/demo';
    await store.load();
    store.activeScheme = null;
    expect(store.channelPersona('chat')).toBeNull();
    store.activeScheme = '不存在的方案';
    expect(store.channelPersona('chat')).toBeNull();
  });
});
