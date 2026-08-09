/**
 * theme.ts —— 壳的唯一偏好源（"可配置默认否"：不设设置面板，改这里重新发版）。
 * tokens 以 CSS 变量注入 :root，组件样式一律吃变量，不写死色值。
 */

export interface ThemePalette {
  /** 纸色（编辑器底色）。 */
  paper: string;
  /** 面板色（侧栏/工具栏/气泡）。 */
  panel: string;
  /** 正文墨色。 */
  ink: string;
  /** 次要文字。 */
  muted: string;
  /** 分隔线。 */
  line: string;
  accent: string;
  ok: string;
  danger: string;
  /** 结构树状态点：草稿/打磨/定稿（其余 status 用 muted）。 */
  statusDraft: string;
  statusPolish: string;
  statusFinal: string;
}

export const palette: Record<'light' | 'dark', ThemePalette> = {
  light: {
    paper: '#FAF7F0',
    panel: '#FFFFFF',
    ink: '#2A2723',
    muted: '#8B867C',
    line: '#E3E1DA',
    accent: '#6B4EFF',
    ok: '#2E9E5B',
    danger: '#C2402E',
    statusDraft: '#B45309',
    statusPolish: '#2563EB',
    statusFinal: '#16A34A',
  },
  dark: {
    paper: '#26241F',
    panel: '#2E2B25',
    ink: '#E8E4DA',
    muted: '#9A9486',
    line: '#3F3B33',
    accent: '#9D8BFF',
    ok: '#4CC38A',
    danger: '#E57373',
    statusDraft: '#F5A623',
    statusPolish: '#6EA8FF',
    statusFinal: '#4CC38A',
  },
};

export const body = {
  fontFamily: '"Source Han Serif SC", "思源宋体", "Noto Serif CJK SC", "Songti SC", serif',
  fontSize: '17px',
  lineHeight: '1.75',
  /** 段首缩进（排版层实现，正文不落全角空格）。 */
  indent: '2em',
  /** 行长 ≤38 字（17px × 38 ≈ 646px，列宽 720 内留白）。 */
  maxWidth: '720px',
};

export const uiFont = '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

export const layout = {
  treeWidth: '260px',
  rightWidth: '360px',
  /** 打字机滚动：光标锁定在滚动视口的 42% 高度处。 */
  typewriterRatio: 0.42,
};

export type ThemeMode = keyof typeof palette;

/** 把某套调色板注入为 :root 的 CSS 变量。 */
export function applyTheme(mode: ThemeMode, root: HTMLElement = document.documentElement): void {
  const p = palette[mode];
  const vars: Record<string, string> = {
    '--paper': p.paper,
    '--panel': p.panel,
    '--ink': p.ink,
    '--muted': p.muted,
    '--line': p.line,
    '--accent': p.accent,
    '--ok': p.ok,
    '--danger': p.danger,
    '--status-draft': p.statusDraft,
    '--status-polish': p.statusPolish,
    '--status-final': p.statusFinal,
    '--body-font': body.fontFamily,
    '--body-size': body.fontSize,
    '--body-leading': body.lineHeight,
    '--body-indent': body.indent,
    '--body-maxwidth': body.maxWidth,
    '--ui-font': uiFont,
    '--tree-w': layout.treeWidth,
    '--right-w': layout.rightWidth,
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset['theme'] = mode;
}

/** status 文本 → 状态点颜色变量名；未知状态回落 muted。 */
export function statusVar(status: string | undefined): string {
  if (status === '草稿') return 'var(--status-draft)';
  if (status === '打磨') return 'var(--status-polish)';
  if (status === '定稿') return 'var(--status-final)';
  return 'var(--muted)';
}
