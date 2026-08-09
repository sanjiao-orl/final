/**
 * ui.svelte.ts —— 界面状态：明暗、专注模式（F8）、右栏（Ctrl+J）、打字机滚动。
 * 偏好不落设置面板；明暗选择只记 localStorage。
 */
import { applyTheme, type ThemeMode } from '../theme.js';

class UiStore {
  mode = $state<ThemeMode>('light');
  /** F8 专注：隐藏左右栏，只留编辑器。 */
  focus = $state(false);
  /** 右栏 AI 面板：默认收起，Ctrl+J 呼出。 */
  rightOpen = $state(false);
  typewriter = $state(true);

  constructor() {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('theme') : null;
    this.mode = saved === 'dark' ? 'dark' : 'light';
    applyTheme(this.mode);
  }

  toggleMode(): void {
    this.mode = this.mode === 'light' ? 'dark' : 'light';
    applyTheme(this.mode);
    localStorage.setItem('theme', this.mode);
  }

  toggleFocus(): void {
    this.focus = !this.focus;
  }

  toggleRight(): void {
    this.rightOpen = !this.rightOpen;
  }

  toggleTypewriter(): void {
    this.typewriter = !this.typewriter;
  }
}

export const ui = new UiStore();
