// 模块职责：提示词与 skill 的统一文件机制（docs/decisions/0008）——解析 prompt 根目录、
// 首次运行把随包缺省文件释放进 app 数据目录（缺才拷、永不覆盖）、按 kind 加载提示词正文、扫描 skill 清单。
// 单一事实源是 md 文件；文件缺失/损坏回退一行兜底提示，不崩。prompt 按 mtime 热重载（改文件即生效），skill 每次现扫。
import fs from 'node:fs';
import path from 'node:path';

export type PromptKind = 'chat' | 'review' | 'rewrite' | 'cold_read';

/** 规范文件名契约（flat 布局，文件名 ASCII）。 */
export const PROMPT_FILENAMES: Record<PromptKind, string> = {
  chat: 'chat.md',
  review: 'review.md',
  rewrite: 'rewrite.md',
  cold_read: 'cold-read.md',
};

/** 规范预置 skill 文件名（随包释放时与 prompt 一起补缺）。 */
export const SKILL_FILENAMES = ['skill-deai-polish.md', 'skill-chapter-checkup.md'] as const;

/** 随包/仓库里需要释放到 app 数据目录的全部规范文件。 */
const CANONICAL_FILES = [...Object.values(PROMPT_FILENAMES), ...SKILL_FILENAMES];

/** 文件缺失/损坏时的一行兜底提示（正本在 core/prompts/）。 */
const PROMPT_FALLBACKS: Record<PromptKind, string> = {
  chat: '你是中文小说写作助手。',
  review: '你是小说冷读审阅员：按输入内容审阅，只输出 findings JSON 数组。',
  rewrite: '你是小说改写器：只输出改写后的正文。',
  cold_read: '你是小说冷读审阅员。',
};

export interface PromptFile {
  frontmatter: Record<string, string>;
  body: string;
  hasFrontmatter: boolean;
}

/** 匹配文件开头的 `---` 包裹块；无 frontmatter 时 body 即全文、hasFrontmatter=false。 */
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** 解析提示词/skill 文件的简单 frontmatter（key: value 每行一个）。 */
export function parsePromptFile(content: string): PromptFile {
  const m = FM_RE.exec(content);
  if (!m) return { frontmatter: {}, body: content, hasFrontmatter: false };
  const frontmatter: Record<string, string> = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    frontmatter[kv[1]!] = kv[2] ?? '';
  }
  return { frontmatter, body: content.slice(m[0].length), hasFrontmatter: true };
}

/**
 * 随包/仓库默认提示词目录（无 NOVEL_PROMPT_DIR 时使用）。
 * dev 下 tsx 跑 core/src/prompts.ts → 仓库 core/prompts；prod 下跑 dist/main.mjs 或
 * sidecar/core/main.mjs → 同级旁的 prompts/。按存在性推导，两种布局都对。
 */
function bundledPromptDir(): string {
  const beside = path.join(import.meta.dirname, 'prompts');
  if (fs.existsSync(beside)) return beside;
  return path.resolve(import.meta.dirname, '..', 'prompts');
}

/** 解析 prompt 根目录：NOVEL_PROMPT_DIR（shell 传入的 app 数据目录）> 随包目录（prod）/ dev 仓库 core/prompts。 */
export function resolvePromptRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.NOVEL_PROMPT_DIR?.trim();
  if (configured) return path.resolve(configured);
  return bundledPromptDir();
}

/**
 * 首次运行释放：把随包目录里的规范文件补缺到目标目录（app 数据目录 prompts/）。
 * 已有文件永不覆盖；随包缺某个文件只 warn 跳过。无 env 的 dev 裸跑不走这里，直接用 core/prompts。
 */
export function releasePrompts(targetDir: string, sourceDir: string = bundledPromptDir()): void {
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    console.warn(`[prompts] 创建提示词目录失败，跳过释放: ${targetDir}（${String(err)}）`);
    return;
  }
  for (const file of CANONICAL_FILES) {
    const target = path.join(targetDir, file);
    if (fs.existsSync(target)) continue;
    const source = path.join(sourceDir, file);
    if (!fs.existsSync(source)) {
      console.warn(`[prompts] 随包提示词缺失，跳过释放: ${source}`);
      continue;
    }
    try {
      fs.copyFileSync(source, target);
    } catch (err) {
      console.warn(`[prompts] 释放提示词失败: ${source} -> ${target}（${String(err)}）`);
    }
  }
}

/** mtime 感知的 prompt 缓存：改文件即生效（决策 0008「单一事实源是 md 文件」），不要求重启。 */
const promptCache = new Map<string, { mtimeMs: number; value: string }>();

/**
 * 读指定 kind 的提示词正文（去 frontmatter）；文件缺失/损坏回退一行兜底提示并 warn，不抛错。
 * mtime 感知热重载：每次调用先 stat，文件 mtimeMs 变化（改内容/替换）、或文件出现/消失（stat 失败按 0 记）
 * 都触发重读并刷新缓存；mtimeMs 相同则直接命中缓存。fallback 逻辑不变。
 */
export function loadPrompt(kind: PromptKind, rootDir: string = activePromptRoot): string {
  const root = path.resolve(rootDir);
  const key = `${root}\n${kind}`;
  const file = path.join(root, PROMPT_FILENAMES[kind]);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // 文件缺失/不可读：按 0 记，缓存里的真实 mtime 一旦存在即视为变化 → 重读（走兜底）。
  }
  const cached = promptCache.get(key);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.value;
  const value = readPromptUncached(kind, root);
  promptCache.set(key, { mtimeMs, value });
  return value;
}

function readPromptUncached(kind: PromptKind, rootDir: string): string {
  const file = path.join(rootDir, PROMPT_FILENAMES[kind]);
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    console.warn(`[prompts] 读取提示词失败，回退兜底提示: ${file}`);
    return PROMPT_FALLBACKS[kind];
  }
  const parsed = parsePromptFile(content);
  if (
    !parsed.hasFrontmatter ||
    parsed.frontmatter.kind !== 'prompt' ||
    parsed.frontmatter.applies_to !== kind ||
    parsed.body.trim() === ''
  ) {
    console.warn(
      `[prompts] 提示词文件 frontmatter 缺失/损坏（需 kind: prompt, applies_to: ${kind}），回退兜底提示: ${file}`
    );
    return PROMPT_FALLBACKS[kind];
  }
  return parsed.body;
}

export interface SkillInfo {
  name: string;
  description: string;
}

/** 扫描一个目录（flat）下所有 kind:skill 的 md；无目录/不可读返回空，坏文件跳过并 warn。 */
export function scanSkills(dir: string): SkillInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const e of entries
    .filter((x) => x.isFile() && x.name.toLowerCase().endsWith('.md'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const file = path.join(dir, e.name);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const parsed = parsePromptFile(content);
    if (!parsed.hasFrontmatter || !parsed.frontmatter.kind) {
      console.warn(`[prompts] 无 frontmatter 或缺 kind，跳过: ${file}`);
      continue;
    }
    if (parsed.frontmatter.kind !== 'skill') continue;
    const name = parsed.frontmatter.name?.trim();
    if (!name) {
      console.warn(`[prompts] skill 缺少 name，跳过: ${file}`);
      continue;
    }
    out.push({ name, description: parsed.frontmatter.description ?? '' });
  }
  return out;
}

/** 合并 app 级与书级 skill 清单；书级（workDir/.novel/skills/）同名（frontmatter name）遮蔽 app 级。 */
export function collectSkills(appDir: string, workDir?: string): SkillInfo[] {
  const byName = new Map<string, string>();
  for (const s of scanSkills(appDir)) byName.set(s.name, s.description);
  if (workDir) {
    const bookDir = path.join(workDir, '.novel', 'skills');
    for (const s of scanSkills(bookDir)) byName.set(s.name, s.description);
  }
  return [...byName.entries()].map(([name, description]) => ({ name, description }));
}

/**
 * 当前进程的 skill 清单：app 目录 + 可选 workDir 书级目录（同名遮蔽）。
 * 每次调用现扫（目录小，聊天请求非热路径），不缓存——与 prompt 热重载一致：skill 文件增删即时生效。
 */
export function listSkills(workDir?: string): SkillInfo[] {
  return collectSkills(activePromptRoot, workDir);
}

/** 声口摘要正文最大字符数：远超上下文无益且挤占对话预算，超长截断并加省略标注。 */
const STYLE_SUMMARY_MAX_CHARS = 1500;

/** 声口档案 style.md 摘要的 mtime 感知缓存（同 loadPrompt 口径：改文件即生效，文件出现/消失触发重读）。 */
const styleSummaryCache = new Map<string, { mtimeMs: number; value: string | null }>();

/**
 * 读书级声口档案 <workDir>/.novel/style.md 的摘要（决策 0010 数据层注入）。
 * 提取 `## 摘要` 节内容（到下一个 `## ` 标题止）；无该节取正文前 1500 字符；
 * 超 1500 字符截断并加省略标注；文件缺失/不可读返回 null（调用方静默跳过，不阻断）。
 * mtime 感知缓存：每次调用先 stat，文件 mtimeMs 变化/出现/消失都触发重读（同 loadPrompt 机制）。
 */
export function loadStyleSummary(workDir: string): string | null {
  const file = path.join(workDir, '.novel', 'style.md');
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // 文件缺失/不可读：按 0 记，缓存里的真实 mtime 一旦存在即视为变化 → 重读（走 null）。
  }
  const cached = styleSummaryCache.get(file);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.value;
  const value = readStyleSummaryUncached(file);
  styleSummaryCache.set(file, { mtimeMs, value });
  return value;
}

function readStyleSummaryUncached(file: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  // 容忍 frontmatter（无则 body 即全文），与 prompt/skill 读取同口径。
  const body = parsePromptFile(content).body;
  const section = extractSummarySection(body);
  let summary = section ?? body;
  if (summary.length > STYLE_SUMMARY_MAX_CHARS) {
    summary = summary.slice(0, STYLE_SUMMARY_MAX_CHARS) + '\n…（声口摘要超 1500 字符，已截断）';
  }
  summary = summary.trim();
  return summary === '' ? null : summary;
}

/** 取 `## 摘要` 节正文（到下一个 `## ` 标题止，不含标题行与后续节）；无该节返回 null。 */
function extractSummarySection(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+摘要\s*$/.test(line));
  if (start < 0) return null;
  const parts: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) break;
    parts.push(lines[i]!);
  }
  return parts.join('\n').trim();
}

/** 进程启动即解析根目录并做首次释放（有 NOVEL_PROMPT_DIR 时），后续 loadPrompt/listSkills 都从这里取。 */
const activePromptRoot: string = (() => {
  const root = resolvePromptRoot(process.env);
  if (process.env.NOVEL_PROMPT_DIR?.trim()) {
    releasePrompts(root, bundledPromptDir());
  }
  return root;
})();
