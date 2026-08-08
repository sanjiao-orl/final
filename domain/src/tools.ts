/**
 * tools.ts —— 五个 MCP 工具的业务实现（不含 MCP 装配）。
 * 结构树永远从文件内容派生；relPath 一律相对 workDir，输出统一用正斜杠。
 */
import fs from 'node:fs';
import path from 'node:path';
import { frontmatterEnd, parseFrontmatter } from './frontmatter.js';
import {
  assertWorkDir,
  atomicWrite,
  collectMdFiles,
  resolveInside,
  toPosix,
  type MdFile,
} from './fsutil.js';

// ---------- 字数统计 ----------

/**
 * 字数口径：非空白字符数（中文写作惯例）。
 * “CJK 字符 + 非空白字符”的并集即全部非空白字符——CJK 字、标点、字母数字都算一个。
 * 只统计正文（frontmatter 是元数据，不计入）。
 */
export function countWords(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (!/\s/.test(ch)) n += 1;
  }
  return n;
}

// ---------- 结构树 ----------

export interface SceneNode {
  type: 'scene';
  title: string;
  /** 章文件内的 1 起始行号（### 所在行）。 */
  line: number;
}

export interface ChapterNode {
  type: 'chapter';
  title: string;
  /** 相对 workDir 的路径，如 manuscript/卷一/第一章.md。 */
  relPath: string;
  status?: string;
  wordCount: number;
  scenes: SceneNode[];
}

export interface VolumeNode {
  type: 'volume';
  title: string;
  children: ChapterNode[];
}

/** manuscript 根目录下的散章归入的隐式卷名。 */
const ROOT_VOLUME_TITLE = '未分卷';

/** 场景标题：### 开头、后随内容；### 与 #### 不会误匹配（要求 # 后必须是空白）。 */
const SCENE_RE = /^###[ \t]+(.+)$/;
/** 一级标题：单个 # 开头；##、### 不误匹配。 */
const H1_RE = /^#(?!#)[ \t]+(.+)$/;

function collectManuscriptFiles(workDir: string): { files: MdFile[] } {
  const msDir = path.join(assertWorkDir(workDir), 'manuscript');
  return { files: collectMdFiles(msDir) };
}

/**
 * list_structure：manuscript 目录树 → 卷/章/场。
 * 卷 = manuscript 的直接子目录；散落在 manuscript 根下的章归入“未分卷”；
 * 更深层的 .md 归入其第一个路径段对应的卷。无 manuscript 目录返回空树。
 */
export function listStructure(workDir: string): VolumeNode[] {
  const { files } = collectManuscriptFiles(workDir);
  if (files.length === 0) return [];

  // 卷 -> 章文件；rel 首段即卷名（空段表示 manuscript 根下的散章）
  const byVolume = new Map<string, MdFile[]>();
  for (const f of files) {
    const seg = f.rel.split(path.sep);
    const key = seg.length > 1 ? seg[0]! : ROOT_VOLUME_TITLE;
    const list = byVolume.get(key) ?? [];
    list.push(f);
    byVolume.set(key, list);
  }

  const volumes: VolumeNode[] = [];
  for (const title of [...byVolume.keys()].sort()) {
    const chapters = byVolume
      .get(title)!
      .map(buildChapter)
      .sort(byFileName); // 卷内按文件名排序（同名的按完整路径兜底），与嵌套层级无关
    volumes.push({ type: 'volume', title, children: chapters });
  }
  return volumes;
}

/** 章排序：文件名升序；重名时按 relPath 兜底，保证稳定。 */
function byFileName(a: ChapterNode, b: ChapterNode): number {
  const na = path.basename(a.relPath);
  const nb = path.basename(b.relPath);
  if (na !== nb) return na < nb ? -1 : 1;
  return a.relPath < b.relPath ? -1 : 1;
}

function buildChapter(f: MdFile): ChapterNode {
  const content = fs.readFileSync(f.abs, 'utf8');
  const fm = parseFrontmatter(content);
  const fmEnd = frontmatterEnd(content);
  const body = content.slice(fmEnd);
  // frontmatter 之后正文首行的 0 起始行号（用于行号定位与标题/场景扫描）
  const bodyStartLine = fmEnd === 0 ? 0 : content.slice(0, fmEnd).split('\n').length - 1;
  const lines = content.split(/\r?\n/);

  // 章标题：frontmatter.title > 首个 H1 > 文件名
  let title: string | undefined = fm.title;
  let firstH1: string | undefined;
  const scenes: SceneNode[] = [];
  for (let i = bodyStartLine; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const h1 = H1_RE.exec(line);
    if (!firstH1 && h1) firstH1 = h1[1]!.trim();
    const sc = SCENE_RE.exec(line);
    if (sc) scenes.push({ type: 'scene', title: sc[1]!.trim(), line: i + 1 });
  }
  if (!title) title = firstH1;
  if (!title) title = path.basename(f.abs, '.md');

  const chapter: ChapterNode = {
    type: 'chapter',
    title,
    relPath: toPosix(path.join('manuscript', f.rel)),
    wordCount: countWords(body),
    scenes,
  };
  if (fm.status) chapter.status = fm.status;
  return chapter;
}

// ---------- 读写章 ----------

export interface ReadChapterResult {
  /** 文件原文（含 frontmatter），与 write_chapter 的 content 可往返。 */
  content: string;
  frontmatter: ReturnType<typeof parseFrontmatter>;
}

/** read_chapter：读取 workDir 内任意文件原文并解析 frontmatter；文件缺失抛错。 */
export function readChapter(workDir: string, relPath: string): ReadChapterResult {
  const abs = resolveInside(workDir, relPath);
  const content = fs.readFileSync(abs, 'utf8');
  return { content, frontmatter: parseFrontmatter(content) };
}

/** write_chapter：仅允许 .md 后缀，原子写（tmp + rename），父目录自动创建。 */
export function writeChapter(
  workDir: string,
  relPath: string,
  content: string,
): { ok: true; bytes: number } {
  if (!relPath.toLowerCase().endsWith('.md')) {
    throw new Error(`write_chapter 只允许 .md 文件: ${relPath}`);
  }
  const abs = resolveInside(workDir, relPath);
  return atomicWrite(abs, content);
}

// ---------- 搜索 ----------

export interface SearchHit {
  /** 相对 workDir 的路径（正斜杠）。 */
  relPath: string;
  /** 1 起始行号。 */
  line: number;
  /** 命中行按前后各 30 字截断（截断处补 …）。 */
  excerpt: string;
}

const EXCERPT_CONTEXT = 30;

/** search_content：大小写不敏感子串匹配，只搜 manuscript/** /*.md，最多 limit 条。 */
export function searchContent(workDir: string, query: string, limit = 20): SearchHit[] {
  const q = query.toLowerCase();
  if (q === '') return [];
  const lim = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 20;
  const { files } = collectManuscriptFiles(workDir);
  const hits: SearchHit[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = fs.readFileSync(f.abs, 'utf8');
    } catch {
      continue; // 读取失败的文件跳过
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const idx = line.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      const start = Math.max(0, idx - EXCERPT_CONTEXT);
      const end = Math.min(line.length, idx + query.length + EXCERPT_CONTEXT);
      const excerpt =
        (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '');
      hits.push({ relPath: toPosix(path.join('manuscript', f.rel)), line: i + 1, excerpt });
      if (hits.length >= lim) return hits;
    }
  }
  return hits;
}

// ---------- 字数统计工具 ----------

export interface WordCountFile {
  relPath: string;
  wordCount: number;
}

export interface WordCountResult {
  total: number;
  /** 汇总时才有：每章明细。 */
  files?: WordCountFile[];
}

/** word_count：给 relPath 只算该章；否则全 manuscript 汇总（含每章明细）。 */
export function wordCount(workDir: string, relPath?: string): WordCountResult {
  if (relPath !== undefined) {
    const abs = resolveInside(workDir, relPath);
    const content = fs.readFileSync(abs, 'utf8');
    return { total: countWords(content.slice(frontmatterEnd(content))) };
  }
  const { files } = collectManuscriptFiles(workDir);
  const items: WordCountFile[] = files.map((f) => {
    const content = fs.readFileSync(f.abs, 'utf8');
    return {
      relPath: toPosix(path.join('manuscript', f.rel)),
      wordCount: countWords(content.slice(frontmatterEnd(content))),
    };
  });
  return {
    total: items.reduce((sum, x) => sum + x.wordCount, 0),
    files: items,
  };
}
