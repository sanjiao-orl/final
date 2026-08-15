// ui.svelte.ts 单测：v4 AI 面板状态机——单栏切换、拖拽钳制、localStorage 持久化、专注独立。
// 不再覆盖 ui.cols / ui.wheelAi / preSettingsCols（已废弃并删除）。
import { beforeEach, describe, expect, it } from 'vitest';
import { UiStore } from './ui.svelte.js';
import { aiColumns } from '../theme.js';

// node 测试环境无 localStorage：polyfill 一个最小可写实现（参照 work.svelte.test.ts 的同款做法）。
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

describe('UiStore 初始状态', () => {
  it('默认收起：activeCol=null, aiOpen=false, isOpen 全部 false', () => {
    const ui = new UiStore();
    expect(ui.activeCol).toBeNull();
    expect(ui.aiOpen).toBe(false);
    expect(ui.isOpen('session')).toBe(false);
    expect(ui.isOpen('chat')).toBe(false);
    expect(ui.isOpen('tools')).toBe(false);
    expect(ui.isOpen('settings')).toBe(false);
    expect(ui.colWidth).toBeGreaterThanOrEqual(280);
  });

  it('默认 colWidth 取 theme 默认 chat 栏宽（来自 aiColumns.width.chat）', () => {
    const ui = new UiStore();
    expect(ui.colWidth).toBe(aiColumns.width.chat);
  });

  it('已废弃 API 不再存在：cols / wheelAi / preSettingsCols', () => {
    const ui = new UiStore() as unknown as Record<string, unknown>;
    expect('cols' in ui).toBe(false);
    expect('wheelAi' in ui).toBe(false);
    expect('preSettingsCols' in ui).toBe(false);
  });
});

describe('UiStore 单栏切换', () => {
  it('showCol(id)：打开并切到该栏；isOpen 只对当前栏为 true', () => {
    const ui = new UiStore();
    ui.showCol('tools');
    expect(ui.aiOpen).toBe(true);
    expect(ui.activeCol).toBe('tools');
    expect(ui.isOpen('tools')).toBe(true);
    expect(ui.isOpen('chat')).toBe(false);
    expect(ui.isOpen('settings')).toBe(false);
  });

  it('toggleCol(id)：同栏再点 = 收起；其他栏点 = 切过去', () => {
    const ui = new UiStore();
    ui.toggleCol('chat'); // 收起 → 打开
    expect(ui.activeCol).toBe('chat');
    expect(ui.aiOpen).toBe(true);

    ui.toggleCol('chat'); // 同栏再点 → 收起
    expect(ui.activeCol).toBeNull();
    expect(ui.aiOpen).toBe(false);

    ui.toggleCol('tools'); // 收起 → 切到 tools
    expect(ui.activeCol).toBe('tools');
    expect(ui.aiOpen).toBe(true);

    ui.toggleCol('session'); // 切到 session
    expect(ui.activeCol).toBe('session');
    expect(ui.isOpen('tools')).toBe(false);
  });

  it('切换栏不重置 colWidth（统一运行时宽）', () => {
    const ui = new UiStore();
    ui.toggleCol('chat');
    ui.setColWidth(420);
    expect(ui.colWidth).toBe(420);
    ui.toggleCol('tools');
    expect(ui.colWidth).toBe(420);
    ui.toggleCol('settings');
    expect(ui.colWidth).toBe(420);
  });
});

describe('UiStore openAi / collapseAi / toggleAi', () => {
  it('collapseAi 后 openAi 回到 lastCol（记忆上次活动栏）', () => {
    const ui = new UiStore();
    ui.toggleCol('tools');
    ui.collapseAi();
    expect(ui.activeCol).toBeNull();
    expect(ui.aiOpen).toBe(false);
    ui.openAi();
    expect(ui.activeCol).toBe('tools');
    expect(ui.aiOpen).toBe(true);
  });

  it('首次 openAi 无 lastCol：默认落 chat', () => {
    const ui = new UiStore();
    ui.openAi();
    expect(ui.activeCol).toBe('chat');
    expect(ui.aiOpen).toBe(true);
  });

  it('toggleAi：开 ↔ 收（与 activeCol 同步）', () => {
    const ui = new UiStore();
    expect(ui.aiOpen).toBe(false);
    ui.toggleAi();
    expect(ui.aiOpen).toBe(true);
    expect(ui.activeCol).toBe('chat');
    ui.toggleAi();
    expect(ui.aiOpen).toBe(false);
    expect(ui.activeCol).toBeNull();
  });

  it('collapseAi 期间 activeCol 被记住；切到别的栏后 openAi 仍回最后那个', () => {
    const ui = new UiStore();
    ui.showCol('tools');
    ui.collapseAi();
    ui.showCol('settings'); // 显式切过另一栏
    ui.collapseAi();
    ui.openAi(); // 应该回到 settings（最后活动的栏）
    expect(ui.activeCol).toBe('settings');
  });
});

describe('UiStore isOpen 语义', () => {
  it('aiOpen=false 时所有栏均不可见', () => {
    const ui = new UiStore();
    ui.showCol('chat');
    ui.collapseAi();
    expect(ui.isOpen('chat')).toBe(false);
    expect(ui.isOpen('tools')).toBe(false);
  });

  it('aiOpen=true 但 activeCol 是另一栏：该栏 isOpen=false', () => {
    const ui = new UiStore();
    ui.showCol('chat');
    expect(ui.isOpen('chat')).toBe(true);
    expect(ui.isOpen('tools')).toBe(false);
  });
});

describe('UiStore focus 独立', () => {
  it('focus 与 AI 开合互不影响', () => {
    const ui = new UiStore();
    expect(ui.focus).toBe(false);
    ui.toggleFocus();
    expect(ui.focus).toBe(true);
    expect(ui.aiOpen).toBe(false);
    ui.toggleAi();
    expect(ui.aiOpen).toBe(true);
    expect(ui.focus).toBe(true); // 仍为 true
    ui.toggleFocus();
    expect(ui.focus).toBe(false);
    expect(ui.aiOpen).toBe(true); // 仍为 true
  });
});

describe('UiStore colWidth 钳制', () => {
  it('setColWidth(小于 280) 钳到下限 280', () => {
    const ui = new UiStore();
    ui.setColWidth(100);
    expect(ui.colWidth).toBe(280);
    ui.setColWidth(0);
    expect(ui.colWidth).toBe(280);
    ui.setColWidth(-50);
    expect(ui.colWidth).toBe(280);
  });

  it('clampWidth：上下界合理', () => {
    const ui = new UiStore();
    // node 环境：availableWidth() 回退 800
    expect(ui.clampWidth(100)).toBe(280);
    expect(ui.clampWidth(280)).toBe(280);
    expect(ui.clampWidth(500)).toBe(500);
    expect(ui.clampWidth(800)).toBe(800);
    expect(ui.clampWidth(99999)).toBe(800); // 上限 = availableWidth
  });

  it('availableWidth：node 环境回退到 800', () => {
    const ui = new UiStore();
    expect(ui.availableWidth()).toBe(800);
  });
});

describe('UiStore localStorage 持久化', () => {
  it('构造时还原 activeCol + colWidth', () => {
    _store.set('ui.activeCol', 'tools');
    _store.set('ui.colWidth', '456');
    const ui = new UiStore();
    expect(ui.activeCol).toBe('tools');
    expect(ui.aiOpen).toBe(true);
    expect(ui.colWidth).toBe(456);
  });

  it('localStorage 中无效 activeCol（不在 order 内）被忽略', () => {
    _store.set('ui.activeCol', 'bogus');
    _store.set('ui.colWidth', '456');
    const ui = new UiStore();
    expect(ui.activeCol).toBeNull();
    expect(ui.colWidth).toBe(456); // width 仍可用
  });

  it('localStorage 中 colWidth 小于 280 被忽略（保留默认值）', () => {
    _store.set('ui.colWidth', '100');
    const ui = new UiStore();
    expect(ui.colWidth).toBeGreaterThanOrEqual(280);
  });

  it('showCol/collapseAi 写回 localStorage', () => {
    const ui = new UiStore();
    ui.showCol('chat');
    expect(_store.get('ui.activeCol')).toBe('chat');
    expect(_store.has('ui.colWidth')).toBe(true);

    ui.collapseAi();
    expect(_store.has('ui.activeCol')).toBe(false); // null 时 removeItem
    expect(_store.has('ui.colWidth')).toBe(true);
  });

  it('setColWidth 写回 localStorage', () => {
    const ui = new UiStore();
    ui.setColWidth(500);
    expect(_store.get('ui.colWidth')).toBe('500');
  });

  it('第二次构造还原上一次的状态（跨实例）', () => {
    const a = new UiStore();
    a.showCol('settings');
    a.setColWidth(480);
    // 新实例：构造时应还原
    const b = new UiStore();
    expect(b.activeCol).toBe('settings');
    expect(b.aiOpen).toBe(true);
    expect(b.colWidth).toBe(480);
  });
});