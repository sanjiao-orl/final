// ui.svelte.ts 单测：v3 AI 面板分栏状态机——点窄条图标开/关栏、滚轮增减栏数、设置栏切换式、专注模式。
import { beforeEach, describe, expect, it } from 'vitest';
import { UiStore } from './ui.svelte.js';

beforeEach(() => {
  // syncWidth 只在浏览器环境写 CSS 变量，node 环境跳过
});

describe('UiStore 分栏状态机', () => {
  it('初始：收起、默认 2 栏（会话+对话）', () => {
    const ui = new UiStore();
    expect(ui.aiOpen).toBe(false);
    expect(ui.cols).toEqual(['session', 'chat']);
    expect(ui.isOpen('chat')).toBe(false); // 收起时不可见
  });

  it('点窄条图标：收起 → 展开 2 栏（该栏 + 左邻；首位取右邻）', () => {
    const ui = new UiStore();
    ui.toggleCol('tools'); // 左邻 chat
    expect(ui.aiOpen).toBe(true);
    expect(ui.cols).toEqual(['chat', 'tools']);
    ui.collapseAi();

    const ui2 = new UiStore();
    ui2.toggleCol('session'); // 首位取右邻 chat
    expect(ui2.cols).toEqual(['session', 'chat']);
  });

  it('点已显栏：>2 栏减栏；仅 2 栏 = 收起', () => {
    const ui = new UiStore();
    ui.toggleCol('tools'); // chat+tools
    ui.toggleCol('session'); // session+chat+tools
    expect(ui.cols).toEqual(['session', 'chat', 'tools']);
    ui.toggleCol('tools'); // 减栏
    expect(ui.cols).toEqual(['session', 'chat']);
    ui.toggleCol('chat'); // 仅 2 栏 → 收起
    expect(ui.aiOpen).toBe(false);
  });

  it('点未显栏：增栏（栏序固定排序）', () => {
    const ui = new UiStore();
    ui.toggleCol('session'); // session+chat
    ui.toggleCol('tools');
    expect(ui.cols).toEqual(['session', 'chat', 'tools']);
  });

  it('滚轮：上滚右端增栏、下滚右端减栏；2 栏下滚收起；收起上滚开 2 栏；收起下滚不动', () => {
    const ui = new UiStore();
    ui.wheelAi(1); // 收起上滚 → session+chat
    expect(ui.aiOpen).toBe(true);
    expect(ui.cols).toEqual(['session', 'chat']);

    ui.wheelAi(1); // 增 tools
    expect(ui.cols).toEqual(['session', 'chat', 'tools']);
    ui.wheelAi(1); // 增至设置栏 → 切换式单栏设置
    expect(ui.cols).toEqual(['settings']);
    ui.wheelAi(1); // 到顶不动
    expect(ui.cols).toEqual(['settings']);

    ui.wheelAi(-1); // 设置单栏下滚 → 收起并还原进设置前的组合
    expect(ui.aiOpen).toBe(false);
    expect(ui.cols).toEqual(['session', 'chat', 'tools']);

    ui.wheelAi(1); // 收起上滚 → 重开默认 2 栏
    expect(ui.aiOpen).toBe(true);
    expect(ui.cols).toEqual(['session', 'chat']);
    ui.wheelAi(-1); // 2 栏下滚 → 收起
    expect(ui.aiOpen).toBe(false);

    ui.wheelAi(-1); // 收起下滚不动
    expect(ui.aiOpen).toBe(false);
  });

  it('设置栏为固定宽切换式：开 = 单栏替换，关 = 还原原组合', () => {
    const ui = new UiStore();
    ui.toggleCol('tools'); // chat+tools
    ui.toggleCol('settings'); // 切单栏设置
    expect(ui.aiOpen).toBe(true);
    expect(ui.cols).toEqual(['settings']);
    ui.toggleCol('settings'); // 关 → 还原
    expect(ui.cols).toEqual(['chat', 'tools']);
    expect(ui.aiOpen).toBe(true);
  });

  it('设置从收起态打开：关闭后直接收起', () => {
    const ui = new UiStore();
    ui.toggleCol('settings');
    expect(ui.cols).toEqual(['settings']);
    expect(ui.aiOpen).toBe(true);
    ui.toggleCol('settings');
    expect(ui.aiOpen).toBe(false);
  });

  it('设置开着时点其他功能栏：切到该栏默认组合', () => {
    const ui = new UiStore();
    ui.toggleCol('settings');
    ui.toggleCol('chat'); // 切到 chat 默认组合 session+chat
    expect(ui.cols).toEqual(['session', 'chat']);
    expect(ui.aiOpen).toBe(true);
  });

  it('设置切换态被整体收起：重开还原进设置前的组合', () => {
    const ui = new UiStore();
    ui.toggleCol('tools'); // chat+tools
    ui.toggleCol('settings');
    ui.collapseAi(); // Esc/点外部/Ctrl+J
    expect(ui.aiOpen).toBe(false);
    ui.openAi();
    expect(ui.cols).toEqual(['chat', 'tools']);
  });

  it('专注模式切换与 AI 开合独立', () => {
    const ui = new UiStore();
    expect(ui.focus).toBe(false);
    ui.toggleFocus();
    expect(ui.focus).toBe(true);
    ui.toggleAi();
    expect(ui.aiOpen).toBe(true);
    ui.toggleAi();
    expect(ui.aiOpen).toBe(false);
  });
});
