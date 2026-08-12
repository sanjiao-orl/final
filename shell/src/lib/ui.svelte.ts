/**
 * ui.svelte.ts —— 界面状态：v3 AI 面板（窄条 48px + 按功能分栏）、F8 专注。
 * 栏序固定：会话(session) / 对话(chat) / 工具(tools) / 设置(settings)。
 * 交互（与 prototype/index.html v3 逻辑一致）：
 * - 默认收起（窄条）；点窄条图标：收起→展开 2 栏（该栏+左邻）；已开→未显栏=增栏，已显栏=减栏（≥2 栏）；仅 2 栏时点已显栏=收起
 * - 滚轮：窄条任意位置 / 面板非内容区，上滚=右端增栏，下滚=右端减栏；2 栏下滚=收起，收起上滚=开 2 栏
 * - Esc/点外部=收起；Ctrl+J/顶栏 AI 按钮=开合；F8 专注连窄条隐藏
 * 明暗/打字机归 settings store（本文件不再持有）。
 */
import { aiColumns, layout } from '../theme.js';

export type AiColId = (typeof aiColumns.order)[number];

export class UiStore {
  /** F8 专注：隐藏左右栏与 AI 窄条，只留编辑器。 */
  focus = $state(false);
  /** AI 面板开合（展开态显示当前可见栏）。 */
  aiOpen = $state(false);
  /** 当前可见栏（按栏序排序），默认 2 栏起。 */
  cols = $state<AiColId[]>(['session', 'chat']);

  constructor() {
    this.syncWidth();
  }

  /** 按可见栏求和更新 --right-w（0.42s 宽度动效）。 */
  private syncWidth(): void {
    if (typeof document === 'undefined') return;
    const w = this.aiOpen ? this.cols.reduce((s, id) => s + (aiColumns.width[id] ?? 0), 0) : 0;
    document.documentElement.style.setProperty('--right-w', `${w}px`);
  }

  isOpen(id: AiColId): boolean {
    return this.aiOpen && this.cols.includes(id);
  }

  toggleFocus(): void {
    this.focus = !this.focus;
  }

  openAi(): void {
    this.aiOpen = true;
    this.syncWidth();
  }

  collapseAi(): void {
    this.aiOpen = false;
    this.syncWidth();
  }

  toggleAi(): void {
    if (this.aiOpen) this.collapseAi();
    else this.openAi();
  }

  /**
   * 点窄条图标 / 栏头 × / 顶栏设置钮：
   * 收起→展开 2 栏（该栏 + 左邻，首位取右邻）；已显→减栏（≥2 栏），仅 2 栏时=收起；未显→增栏。
   */
  toggleCol(id: AiColId): void {
    if (!this.aiOpen) {
      const i = aiColumns.order.indexOf(id);
      const n = i > 0 ? aiColumns.order[i - 1]! : aiColumns.order[i + 1]!;
      this.cols = [n, id].sort(byOrder);
      this.openAi();
    } else if (this.cols.includes(id)) {
      if (this.cols.length > 2) {
        this.cols = this.cols.filter((x) => x !== id);
        this.syncWidth();
      } else {
        this.collapseAi();
      }
    } else {
      this.cols = [...this.cols, id].sort(byOrder);
      this.syncWidth();
    }
  }

  /** 滚轮切换：dir>0 上滚=右端增栏；dir<0 下滚=右端减栏；收起态上滚=开 2 栏。 */
  wheelAi(dir: number): void {
    if (!this.aiOpen) {
      if (dir < 0) return;
      this.cols = ['session', 'chat'];
      this.openAi();
      return;
    }
    if (dir > 0) {
      const last = [...this.cols].sort(byOrder).pop()!;
      const add = aiColumns.order[aiColumns.order.indexOf(last) + 1];
      if (add) {
        this.cols = [...this.cols, add].sort(byOrder);
        this.syncWidth();
      }
    } else {
      if (this.cols.length > 2) {
        const last = [...this.cols].sort(byOrder).pop()!;
        this.cols = this.cols.filter((x) => x !== last);
        this.syncWidth();
      } else {
        this.collapseAi();
      }
    }
  }
}

function byOrder(a: AiColId, b: AiColId): number {
  return aiColumns.order.indexOf(a) - aiColumns.order.indexOf(b);
}

/** 面板完全收起时工具栏/窄条也不该占用 --right-w（CSS 已按宽度 0 处理）。 */
export const railWidth = layout.railWidth;

export const ui = new UiStore();
