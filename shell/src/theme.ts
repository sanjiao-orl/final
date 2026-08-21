/**
 * theme.ts —— 壳的唯一偏好源（"可配置默认否"：默认最保守，设置面板可改）。
 * tokens 以 CSS 变量注入 :root，组件样式一律吃变量，不写死色值。
 * 与 prototype/index.html 的 :root 严格同名同值（v3 起派生语义色同源搬运）。
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
  /** 结构树状态点：草稿/已发布/已校对（其余 status 用 muted）。 */
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
  lineHeight: '1.6',
  /** 段首缩进（排版层实现，正文不落全角空格）。 */
  indent: '2em',
  /** 行长 ≤38 字（17px × 38 ≈ 646px，列宽 720 内留白）。 */
  maxWidth: '720px',
};

export const uiFont = '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

/**
 * 默认字号（17px）下正文行高（px）= fontSize × lineHeight，取整对齐 .prose line-height。
 * Editor 选区浮动条按此基准定位行间隙；改字号时 lineHeight 应同步重算（见 applyTheme 的派生逻辑）。
 * 显式声明耦合（v4 D5 行距校到 1.6 区间）：17 × 1.6 = 27.2 → 27。
 */
const DEFAULT_FONT_SIZE = 17;
const DEFAULT_LINE_RATIO = 1.6;
const DEFAULT_LINE_PX = Math.round(DEFAULT_FONT_SIZE * DEFAULT_LINE_RATIO); // 27

/**
 * 给定字号按 lineHeight 比例派生 px 行高。Editor 用以在字号变化后保持选区浮动条贴行间隙。
 * 浮动条定位的"魔法 30"从此函数派生，不再散落硬编码。
 */
export function lineHeightPx(fontSize: number, ratio: number = DEFAULT_LINE_RATIO): number {
  return Math.round(fontSize * ratio);
}

export const layout = {
  treeWidth: '260px',
  rightWidth: '360px',
  /** AI 窄条（默认收起态）宽度。 */
  railWidth: '48px',
  /** 顶栏高度。 */
  toolbarHeight: '42px',
  /** 打字机滚动：光标锁定在滚动视口的 42% 高度处。 */
  typewriterRatio: 0.42,
  /** 默认字号 17px 下的 px 行高（30px）；字号变化时由 applyTheme 重新派生 --body-line-px 注入文档根。 */
  lineHeight: DEFAULT_LINE_PX,
  /** B1 多候选浮层宽度（px，与原型一致）。新增覆盖层只准取以下两档：
   *  - selPopWidth (580, 浮层一档) —— 选区候选/AI 暂存抽离推荐卡片等侧挂卡片
   *  - overlayModal (480, 模态一档) —— 审批卡/速查卡/快照浏览器等居中模态
   *  其他覆盖层宽度需求先沿用其中之一，不在 theme 私自开新档。 */
  selPopWidth: 580,
  /** 居中模态宽度（px）：审批卡/速查卡/快照浏览器等；与 selPopWidth 同源取自原型一档。 */
  overlayModal: 480,
  /** 选区浮动条估算高度（px），浮动条定位用。 */
  selBarHeight: 38,
  /** 浮动条相对行顶的垂直偏移（px）：主路径卡在 [行顶-8, 行顶+30] 行间隙，只覆盖选区行自身。 */
  selBarGap: 8,
  /** 浮动条贴视口边距（px，垂直）。 */
  selBarMinGap: 4,
  /** 浮动条贴视口边距（px，水平）。 */
  selBarMinLeft: 8,
};

/**
 * v4 AI 面板：单栏切换 + 拖拽调宽——多栏求和裁切已从机制上消除。
 * - order：栏 id 字面量来源（AiColId 推导）；栏序不再驱动叠加，但仍是规范列表。
 * - width：各栏初始宽度（px），仅作 UiStore 冷启动默认值；运行时栏宽统一由 ui.colWidth 持有。
 * --right-w 直接 = ui.colWidth（无求和）。
 */
export const aiColumns = {
  order: ['session', 'chat', 'tools', 'context', 'settings'] as const,
  width: { session: 280, chat: 320, tools: 280, context: 300, settings: 300 } as Record<string, number>,
};

export type ThemeMode = keyof typeof palette;

/** 派生语义色：一律 color-mix 由主 tokens 派生（与原型同温同饱和），不新造主色。 */
function derivedVars(mode: ThemeMode): Record<string, string> {
  const light = mode === 'light';
  return {
    '--accent-soft': 'color-mix(in srgb, var(--accent) 9%, transparent)',
    '--accent-line': 'color-mix(in srgb, var(--accent) 32%, var(--line))',
    '--sel-hl': 'color-mix(in srgb, var(--accent) 13%, transparent)',
    '--suggest-bg': 'color-mix(in srgb, var(--ok) 8%, transparent)',
    '--suggest-line': 'color-mix(in srgb, var(--ok) 38%, var(--line))',
    /** 碰撞模式（批一③）节标题/边框色：pro 取 ok（正面：方案/裁决），con 取 danger（反面：漏洞/反方）。 */
    '--collide-pro': 'color-mix(in srgb, var(--ok) 70%, var(--muted))',
    '--collide-con': 'color-mix(in srgb, var(--danger) 70%, var(--muted))',
    '--strike': 'color-mix(in srgb, var(--danger) 55%, var(--muted))',
    '--warn-bg': 'color-mix(in srgb, var(--status-draft) 9%, transparent)',
    /** 主行动按钮文字色：恒白/近白，accent 背景上两种主题都保证可读，避免硬编码 #fff。 */
    '--on-accent': '#FFFFFF',
    '--shadow-pop': light
      ? '0 1px 2px rgba(42,39,35,.05), 0 8px 28px -6px rgba(42,39,35,.14)'
      : '0 1px 2px rgba(0,0,0,.25), 0 8px 28px -6px rgba(0,0,0,.45)',
    '--shadow-modal': light
      ? '0 2px 6px rgba(42,39,35,.08), 0 24px 64px -12px rgba(42,39,35,.28)'
      : '0 2px 6px rgba(0,0,0,.35), 0 24px 64px -12px rgba(0,0,0,.6)',
  };
}

/**
 * 把某套调色板注入为 :root 的 CSS 变量。
 * fontSize 可覆盖正文字号（设置面板 15/17/19），改字号需同步 layout.lineHeight
 * （Editor 浮动条按 30px 行高定位，见 Editor.svelte 注释）。
 */
export function applyTheme(mode: ThemeMode, root: HTMLElement = document.documentElement, fontSize?: number): void {
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
    '--body-size': fontSize !== undefined ? `${fontSize}px` : body.fontSize,
    '--body-leading': body.lineHeight,
    '--body-line-px': `${lineHeightPx(fontSize ?? parseInt(body.fontSize, 10))}px`,
    '--body-indent': body.indent,
    '--body-maxwidth': body.maxWidth,
    '--ui-font': uiFont,
    '--tree-w': layout.treeWidth,
    '--rail-w': layout.railWidth,
    '--toolbar-h': layout.toolbarHeight,
    '--overlay-modal': `${layout.overlayModal}px`,
    '--ease-fold': 'cubic-bezier(0.4, 0, 0.2, 1)',
    '--t-fold': '0.42s cubic-bezier(0.4, 0, 0.2, 1)',
    '--t-hover': '0.15s ease',
    ...derivedVars(mode),
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset['theme'] = mode;
}

/** status 文本 → 状态点颜色变量名；未知状态回落 muted。 */
export function statusVar(status: string | undefined): string {
  if (status === '草稿') return 'var(--status-draft)';
  if (status === '已发布') return 'var(--status-polish)';
  if (status === '已校对') return 'var(--status-final)';
  return 'var(--muted)';
}

/**
 * 碰撞节 → 节色变量（批一③）。方案=pro（正面，ok 系绿）、漏洞/反方=con（反面，danger 系红）、
 * 裁决=accent（与方案同属正面但用主题强调色区分客观裁决与提议，视觉上更醒目）。
 */
export function collideVar(sec: '方案' | '漏洞' | '反方' | '裁决'): string {
  if (sec === '方案') return 'var(--collide-pro)';
  if (sec === '裁决') return 'var(--accent)';
  return 'var(--collide-con)';
}
