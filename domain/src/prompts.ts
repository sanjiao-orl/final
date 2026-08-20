/**
 * domain/src/prompts.ts —— 提示词/skill 文件的最小加载器，与 core/src/prompts.ts 互为镜像（口径一致）：
 * frontmatter 格式、目录解析顺序（NOVEL_PROMPT_DIR > 随包/仓库 core/prompts）、坏文件跳过并 warn。
 * domain 侧消费的提示词事实源：cold-read.md（冷读契约，见 ledger.ts）、kind:skill 文件（skill_read 按需拉正文）
 * 与写作方案文件（scheme_set_active 校验/写入激活指针）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertWorkDir, atomicWrite, resolveInside } from './fsutil.js';

export type PromptKind = 'cold_read';

export const PROMPT_FILENAMES: Record<PromptKind, string> = {
  cold_read: 'cold-read.md',
};

export interface PromptFile {
  frontmatter: Record<string, string>;
  body: string;
  hasFrontmatter: boolean;
}

/** 与 core/src/prompts.ts 相同的简单 frontmatter 解析：无块则 body 即全文。 */
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

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
 * 解析 prompt 根目录：NOVEL_PROMPT_DIR（core spawn domain 时透传）优先；
 * 缺省按模块位置推导仓库/随包 core/prompts（dev 与 prod sidecar 布局都能对）。
 */
export function resolvePromptRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.NOVEL_PROMPT_DIR?.trim();
  if (configured) return path.resolve(configured);
  const devRepo = path.resolve(import.meta.dirname, '..', '..', 'core', 'prompts');
  if (fs.existsSync(devRepo)) return devRepo;
  return path.resolve(import.meta.dirname, '..', 'core', 'prompts');
}

const promptCache = new Map<string, string | null>();

/** 读提示词正文；文件缺失/损坏返回 null（调用方自行决定兜底），并 warn 不抛错。 */
export function loadPrompt(kind: PromptKind, rootDir: string = resolvePromptRoot()): string | null {
  const root = path.resolve(rootDir);
  const key = `${root}\n${kind}`;
  if (promptCache.has(key)) return promptCache.get(key)!;
  const value = readPromptUncached(kind, root);
  promptCache.set(key, value);
  return value;
}

function readPromptUncached(kind: PromptKind, rootDir: string): string | null {
  const file = path.join(rootDir, PROMPT_FILENAMES[kind]);
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    console.warn(`[domain prompts] 读取提示词失败: ${file}`);
    return null;
  }
  const parsed = parsePromptFile(content);
  if (
    !parsed.hasFrontmatter ||
    parsed.frontmatter.kind !== 'prompt' ||
    parsed.frontmatter.applies_to !== kind ||
    parsed.body.trim() === ''
  ) {
    console.warn(
      `[domain prompts] 提示词文件 frontmatter 缺失/损坏（需 kind: prompt, applies_to: ${kind}）: ${file}`
    );
    return null;
  }
  return parsed.body;
}

export interface SkillInfo {
  name: string;
  description: string;
}

export interface SkillFile extends SkillInfo {
  /** 文件绝对路径。 */
  file: string;
  body: string;
}

/** 扫描目录下所有 kind:skill 的 md（flat）；无目录返回空，坏文件跳过并 warn。 */
export function scanSkillFiles(dir: string): SkillFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillFile[] = [];
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
      console.warn(`[domain prompts] 无 frontmatter 或缺 kind，跳过: ${file}`);
      continue;
    }
    if (parsed.frontmatter.kind !== 'skill') continue;
    const name = parsed.frontmatter.name?.trim();
    if (!name) {
      console.warn(`[domain prompts] skill 缺少 name，跳过: ${file}`);
      continue;
    }
    out.push({
      file,
      name,
      description: parsed.frontmatter.description ?? '',
      body: parsed.body,
    });
  }
  return out;
}

/** 按 frontmatter name 找 skill 文件；找不到返回 null。 */
export function findSkillByName(dir: string, name: string): SkillFile | null {
  return scanSkillFiles(dir).find((s) => s.name === name) ?? null;
}

/**
 * skill_read 业务实现：先在 <workDir>/.novel/skills/ 找（书级遮蔽 app 级），
 * 再到 app prompt 目录（NOVEL_PROMPT_DIR）找；命中返回正文，未命中抛中文错。
 * 书级目录路径经 resolveInside 守卫，与 domain 现有口径一致。
 */
export function readSkillBody(workDir: string, name: string, appPromptDir: string = resolvePromptRoot()): string {
  const wd = assertWorkDir(workDir);
  const bookDir = resolveInside(wd, '.novel/skills');
  const book = findSkillByName(bookDir, name);
  if (book) return book.body;
  const app = findSkillByName(appPromptDir, name);
  if (app) return app.body;
  throw new Error(`skill_read 找不到 skill: ${name}`);
}

// ---------- 写作方案（scheme_set_active 的可用集扫描与激活指针） ----------

export interface SchemeInfo {
  name: string;
  description: string;
}

export interface SchemeFile extends SchemeInfo {
  /** 文件绝对路径。 */
  file: string;
  body: string;
}

/** 扫描目录下所有带 frontmatter name 的方案 md（flat）；无目录返回空，缺 name/坏文件跳过并 warn。 */
export function scanSchemeFiles(dir: string): SchemeFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SchemeFile[] = [];
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
    const name = parsed.frontmatter.name?.trim();
    if (!name) {
      console.warn(`[domain prompts] 方案 md 缺少 frontmatter name，跳过: ${file}`);
      continue;
    }
    out.push({ file, name, description: parsed.frontmatter.description ?? '', body: parsed.body });
  }
  return out;
}

/** 「激活方案」指针固定路径（相对 workDir），单行文本=方案 frontmatter name；无文件=默认不激活。 */
export const ACTIVE_SCHEME_REL = '.novel/active-scheme';

/**
 * scheme_set_active 业务实现：把「激活方案」指针写入作品目录。
 * - name 非空 → 校验其属于可用方案集（app 预置 <promptRoot>/schemes 与书级 .novel/schemes 的 frontmatter name 并集，
 *   同名书级遮蔽 app 级），命中则原子写 .novel/active-scheme（内容=name 单行+结尾换行）；
 *   未命中抛中文错并列可用方案名。
 * - name 为空串 → 删除指针文件（不存在则幂等成功），回到默认（不激活）。
 * 路径固定 .novel/active-scheme，不接受任何路径参数；不做历史快照。
 * 返回 { ok: true, active: string | null }。
 */
export function schemeSetActive(
  workDir: string,
  name: string,
  appPromptDir: string = resolvePromptRoot(),
): { ok: true; active: string | null } {
  const wd = assertWorkDir(workDir);
  const pointer = resolveInside(wd, ACTIVE_SCHEME_REL);
  const trimmed = name?.trim() ?? '';
  if (trimmed === '') {
    fs.rmSync(pointer, { force: true }); // 无 .novel/ 目录或指针不存在同样幂等成功
    return { ok: true, active: null };
  }
  const bookDir = resolveInside(wd, '.novel/schemes');
  const available = [
    ...new Set<string>([
      ...scanSchemeFiles(bookDir).map((s) => s.name),
      ...scanSchemeFiles(path.join(appPromptDir, 'schemes')).map((s) => s.name),
    ]),
  ].sort();
  if (!available.includes(trimmed)) {
    const list =
      available.length > 0
        ? available.join('、')
        : '（暂无可用方案，可在 .novel/schemes/ 放置带 frontmatter name 的方案 md）';
    throw new Error(`scheme_set_active 找不到方案「${trimmed}」，可用方案：${list}`);
  }
  atomicWrite(pointer, `${trimmed}\n`);
  return { ok: true, active: trimmed };
}
