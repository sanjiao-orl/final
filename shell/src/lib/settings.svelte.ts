/**
 * settings.svelte.ts —— 设置面板（开放项 2 定稿清单）：
 * 审批模式 ask/auto/yolo、主题明/暗、正文字号 15/17/19、打字机滚动、自动保存间隔、
 * 采纳前自动快照（常开不可关）、小改就地分流、采纳留痕。默认值全部最保守。
 * 持久化 localStorage；主题/字号写回 CSS 变量（theme.ts 唯一来源）。
 */
import { applyTheme, type ThemeMode } from '../theme.js';

export type ApprovalMode = 'ask' | 'auto' | 'yolo';

export interface SettingsShape {
  approvalMode: ApprovalMode;
  mode: ThemeMode;
  fontSize: 15 | 17 | 19;
  typewriter: boolean;
  autosaveSec: 30 | 60 | 120;
  /** 采纳/危险操作前自动快照：建议不允许关，仅列出以示存在（B4 不受审批模式影响）。 */
  snapshotBeforeAdopt: boolean;
  /** 小改就地浮层 / 大改进暂存的分流（B1）：关则全部进暂存。 */
  inlineSplit: boolean;
  /** 采纳留痕：显示"为何采纳"（B8）。 */
  showInstruction: boolean;
}

const DEFAULTS: SettingsShape = {
  approvalMode: 'ask',
  mode: 'light',
  fontSize: 17,
  typewriter: true,
  autosaveSec: 60,
  snapshotBeforeAdopt: true,
  inlineSplit: true,
  showInstruction: true,
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

class SettingsStore {
  approvalMode = $state<ApprovalMode>(DEFAULTS.approvalMode);
  mode = $state<ThemeMode>(DEFAULTS.mode);
  fontSize = $state<15 | 17 | 19>(DEFAULTS.fontSize);
  typewriter = $state(DEFAULTS.typewriter);
  autosaveSec = $state<30 | 60 | 120>(DEFAULTS.autosaveSec);
  snapshotBeforeAdopt = $state(DEFAULTS.snapshotBeforeAdopt);
  inlineSplit = $state(DEFAULTS.inlineSplit);
  showInstruction = $state(DEFAULTS.showInstruction);

  constructor() {
    // 旧版 ui store 用 'theme' key 记明暗，向后兼容
    const legacy = typeof localStorage !== 'undefined' ? localStorage.getItem('theme') : null;
    this.mode = legacy === 'dark' ? 'dark' : load<ThemeMode>('settings.mode', DEFAULTS.mode);
    this.approvalMode = load<ApprovalMode>('settings.approval', DEFAULTS.approvalMode);
    this.fontSize = load<15 | 17 | 19>('settings.fontSize', DEFAULTS.fontSize);
    this.typewriter = load<boolean>('settings.typewriter', DEFAULTS.typewriter);
    this.autosaveSec = load<30 | 60 | 120>('settings.autosave', DEFAULTS.autosaveSec);
    this.snapshotBeforeAdopt = DEFAULTS.snapshotBeforeAdopt; // 常开，不落盘
    this.inlineSplit = load<boolean>('settings.inlineSplit', DEFAULTS.inlineSplit);
    this.showInstruction = load<boolean>('settings.showInstruction', DEFAULTS.showInstruction);
    this.applyVisual();
  }

  private persist(): void {
    save('settings.mode', this.mode);
    save('settings.approval', this.approvalMode);
    save('settings.fontSize', this.fontSize);
    save('settings.typewriter', this.typewriter);
    save('settings.autosave', this.autosaveSec);
    save('settings.inlineSplit', this.inlineSplit);
    save('settings.showInstruction', this.showInstruction);
    localStorage.removeItem('theme'); // 旧 key 让位
  }

  /** 主题/字号落 CSS 变量（theme.ts）；非浏览器环境（单测）跳过。 */
  applyVisual(): void {
    if (typeof document === 'undefined') return;
    applyTheme(this.mode, document.documentElement, this.fontSize);
  }

  setMode(mode: ThemeMode): void {
    this.mode = mode;
    this.applyVisual();
    this.persist();
  }

  toggleMode(): void {
    this.setMode(this.mode === 'light' ? 'dark' : 'light');
  }

  setFontSize(n: 15 | 17 | 19): void {
    this.fontSize = n;
    this.applyVisual();
    this.persist();
  }

  setApproval(mode: ApprovalMode): void {
    this.approvalMode = mode;
    this.persist();
  }

  setTypewriter(on: boolean): void {
    this.typewriter = on;
    this.persist();
  }

  setAutosave(sec: 30 | 60 | 120): void {
    this.autosaveSec = sec;
    this.persist();
  }

  setInlineSplit(on: boolean): void {
    this.inlineSplit = on;
    this.persist();
  }

  setShowInstruction(on: boolean): void {
    this.showInstruction = on;
    this.persist();
  }
}

export const settings = new SettingsStore();
