/**
 * domain/src/prompts.ts —— 提示词/skill 文件的最小加载器，与 core/src/prompts.ts 互为镜像（口径一致）：
 * frontmatter 格式、目录解析顺序（NOVEL_PROMPT_DIR > 随包/仓库 core/prompts）、坏文件跳过并 warn。
 * domain 侧只消费两份事实源：cold-read.md（冷读契约，见 ledger.ts）与 kind:skill 文件（skill_read 按需拉正文）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertWorkDir, resolveInside } from './fsutil.js';

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
