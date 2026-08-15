/**
 * ui.svelte.ts —— 界面状态：v3 AI 面板（窄条 48px + 按功能分栏）、F8 专注。
 * 栏序固定：会话(session) / 对话(chat) / 工具(tools) / 设置(settings)。
 * 交互（与 prototype/index.html v3 逻辑一致）：
 * - 默认收起（窄条）；点窄条图标：收起→展开 2 栏（该栏+左邻）；已开→未显栏=增栏，已显栏=减栏（≥2 栏）；仅 2 栏时点已显栏=收起
 * - 设置栏例外（固定宽切换式）：点开=单栏替换当前组合（记住原组合），再点/×=还原原组合（无则收起）；
 *   设置开着时点其他功能栏=切到该栏默认组合。多栏叠加时设置栏会被 .ai 的 max-width 裁掉右缘，故不入叠加体系。
 * - 滚轮：窄条任意位置 / 面板非内容区，上滚=右端增栏，下滚=右端减栏；2 栏下滚=收起，收起上滚=开 2 栏；增至设置栏=切单栏设置
 * - Esc/点外部=收起；Ctrl+J/顶栏 AI 按钮=开合；F8 专注连窄条隐藏
 * 明暗/打字机归 settings store（本文件不再持有）。
 */
import { aiColumns } from '../theme.js';

export type AiColId = (typeof aiColumns.order)[number];

export class UiStore {
  /** F8 专注：隐藏左右栏与 AI 窄条，只留编辑器。 */
  focus = $state(false);
  /** AI 面板开合（展开态显示当前可见栏）。 */
  aiOpen = $state(false);
  /** 当前可见栏（按栏序排序），默认 2 栏起。 */
  cols = $state<AiColId[]>(['session', 'chat']);

  /** 进设置切换态前记住的栏组合；null=进设置前是收起态。 */
  private preSettingsCols: AiColId[] | null = null;

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
    // 设置切换态被整体收起（Esc/点外部/Ctrl+J）：还原进设置前的栏组合，重开面板回到原视图。
    if (this.preSettingsCols) {
      this.cols = this.preSettingsCols;
      this.preSettingsCols = null;
    }
    this.syncWidth();
  }

  toggleAi(): void {
    if (this.aiOpen) this.collapseAi();
    else this.openAi();
  }

  /** 开设置：记住当前栏组合，切到单栏固定宽设置。 */
  private openSettings(): void {
    if (!this.isOpen('settings')) {
      this.preSettingsCols = this.aiOpen ? [...this.cols] : null;
      this.cols = ['settings'];
    }
    this.openAi();
  }

  /** 关设置：还原进设置前的栏组合；之前是收起态则直接收起。 */
  private closeSettings(): void {
    const prev = this.preSettingsCols;
    this.preSettingsCols = null;
    if (prev && prev.length > 0) {
      this.cols = prev;
      this.syncWidth();
    } else {
      this.collapseAi();
    }
  }

  /**
   * 点窄条图标 / 栏头 × / 顶栏设置钮：
   * 设置栏走切换式（开=单栏替换，关=还原）；其余栏：收起→展开 2 栏（该栏 + 左邻，首位取右邻），
   * 已显→减栏（≥2 栏），仅 2 栏时=收起；未显→增栏。设置开着时点其他栏=切到该栏默认组合。
   */
  toggleCol(id: AiColId): void {
    if (id === 'settings') {
      if (this.isOpen('settings')) this.closeSettings();
      else this.openSettings();
      return;
    }
    if (!this.aiOpen || this.isOpen('settings')) {
      // 收起态点栏，或设置切换态改点其他功能栏：都切到该栏默认组合。
      this.preSettingsCols = null;
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
      if (add === 'settings') {
        // 增至设置栏 = 切单栏设置（切换式，不叠加）
        this.openSettings();
      } else if (add) {
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

export const ui = new UiStore();
