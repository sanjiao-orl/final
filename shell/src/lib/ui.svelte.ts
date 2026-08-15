/**
 * ui.svelte.ts —— 界面状态：v4 AI 面板（单栏切换 + 拖拽调宽）、F8 专注。
 * 单活动栏 activeCol（session/chat/tools/settings 四选一），栏宽为运行时 ui.colWidth，
 * 左缘拖拽手柄钳制到 [280, 可用宽]，持久化到 localStorage。
 * 从机制上不存在多栏求和裁切：宽度即栏宽，溢出在面板内滚动，降级是"收起"不是"裁切"。
 * 兼容保留：ui.aiOpen 仍为外部可读字段（与 activeCol !== null 同步），供 App.svelte/Toolbar 使用；
 * 已废弃的 ui.cols / ui.wheelAi / preSettingsCols / openSettings/closeSettings 全部删除。
 */
import { aiColumns } from '../theme.js';

export type AiColId = (typeof aiColumns.order)[number];

/** 栏宽下限（原型最窄宽度）；上限由窗口内可用宽决定（availableWidth）。 */
const MIN_COL_W = 280;
/** openAi() 无记忆时默认落到的栏。 */
const DEFAULT_COL: AiColId = 'chat';
/** colWidth 初值：取 chat 栏宽作为统一初始值；其余栏宽仅作历史/参考。 */
const DEFAULT_WIDTH: number = aiColumns.width[DEFAULT_COL] ?? aiColumns.width.chat ?? 280;
/** 持久化键名。 */
const KEY_ACTIVE = 'ui.activeCol';
const KEY_WIDTH = 'ui.colWidth';

export class UiStore {
  /** F8 专注：隐藏左右栏与 AI 窄条，只留编辑器。 */
  focus = $state(false);
  /** 当前活动栏 id；null = 面板收起（只剩窄条）。 */
  activeCol = $state<AiColId | null>(null);
  /** AI 面板开合：与 activeCol !== null 同步保留，供 App.svelte / Toolbar 读取。 */
  aiOpen = $state(false);
  /** 当前栏宽（运行时，所有栏共享一个统一值；切栏不重置）。 */
  colWidth = $state<number>(DEFAULT_WIDTH);
  /** openAi() 回退用的"上次活动栏"；首次启动为默认 chat。 */
  lastCol = $state<AiColId>(DEFAULT_COL);

  constructor() {
    if (typeof localStorage !== 'undefined') this.hydrate();
    if (typeof window !== 'undefined') this.bindResize();
    this.syncWidth();
  }

  /** 还原持久化状态；node / 隐私模式等无 localStorage 时静默跳过。 */
  private hydrate(): void {
    try {
      const a = localStorage.getItem(KEY_ACTIVE);
      if (a && (aiColumns.order as readonly string[]).includes(a)) {
        this.activeCol = a as AiColId;
        this.aiOpen = true;
        this.lastCol = a as AiColId;
      }
      const w = Number(localStorage.getItem(KEY_WIDTH));
      if (Number.isFinite(w) && w >= MIN_COL_W) this.colWidth = Math.round(w);
    } catch {
      // localStorage 不可写（隐私模式 / 受限环境）：忽略，内存态生效即可
    }
  }

  /** 窗口变窄时同步收缩栏宽——保留用户既定宽度不变窄侧重排。 */
  private bindResize(): void {
    window.addEventListener('resize', () => {
      const max = this.availableWidth();
      if (this.colWidth > max) {
        this.colWidth = max;
        this.persist();
        this.syncWidth();
      }
    });
  }

  /** 窗口内可用宽 = 视口 - 树宽 - 窄条宽 - 编辑器最小宽(160)。 */
  availableWidth(): number {
    if (typeof window === 'undefined') return 800;
    const root = document.documentElement;
    const tree = parseInt(getComputedStyle(root).getPropertyValue('--tree-w'), 10) || 260;
    const rail = parseInt(getComputedStyle(root).getPropertyValue('--rail-w'), 10) || 48;
    return Math.max(MIN_COL_W, window.innerWidth - tree - rail - 160);
  }

  /** 钳制栏宽到 [280, 可用宽]。 */
  clampWidth(px: number): number {
    const max = Math.max(MIN_COL_W, this.availableWidth());
    const v = Math.round(px);
    return Math.min(max, Math.max(MIN_COL_W, v));
  }

  /** 由拖拽手柄 / AiPanel 调用：钳制 + 持久化 + 同步 CSS 变量。 */
  setColWidth(px: number): void {
    this.colWidth = this.clampWidth(px);
    this.persist();
    this.syncWidth();
  }

  /** 栏是否可见：面板开 且 该栏为当前活动栏（取代 v3 的 ui.cols.includes）。 */
  isOpen(id: AiColId): boolean {
    return this.aiOpen && this.activeCol === id;
  }

  /** 打开面板：恢复到 lastCol 或默认 chat。 */
  openAi(): void {
    this.aiOpen = true;
    if (!this.activeCol) this.activeCol = this.lastCol;
    this.persist();
    this.syncWidth();
  }

  /** 收起面板：记住当前栏作为 lastCol，下次 openAi 还原。 */
  collapseAi(): void {
    if (this.activeCol) this.lastCol = this.activeCol;
    this.activeCol = null;
    this.aiOpen = false;
    this.persist();
    this.syncWidth();
  }

  toggleAi(): void {
    if (this.aiOpen) this.collapseAi();
    else this.openAi();
  }

  /** 显式打开并切到指定栏（外部跳转 / 顶部按钮 / 超链接用）。 */
  showCol(id: AiColId): void {
    this.activeCol = id;
    this.aiOpen = true;
    this.lastCol = id;
    this.persist();
    this.syncWidth();
  }

  /** 窄条图标 / AiPanel 栏头 ×：同栏再点 = 收起；否则切过去。 */
  toggleCol(id: AiColId): void {
    if (this.activeCol === id) this.collapseAi();
    else this.showCol(id);
  }

  toggleFocus(): void {
    this.focus = !this.focus;
  }

  /** --right-w：单栏宽（不存在求和），0 = 收起。 */
  private syncWidth(): void {
    if (typeof document === 'undefined') return;
    const w = this.aiOpen ? this.colWidth : 0;
    document.documentElement.style.setProperty('--right-w', `${w}px`);
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      if (this.activeCol) localStorage.setItem(KEY_ACTIVE, this.activeCol);
      else localStorage.removeItem(KEY_ACTIVE);
      localStorage.setItem(KEY_WIDTH, String(this.colWidth));
    } catch {
      // 隐私模式 / 受限环境下忽略，内存态生效
    }
  }
}

export const ui = new UiStore();