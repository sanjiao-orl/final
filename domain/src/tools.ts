/**
 * tools.ts —— 五个 MCP 工具的业务实现（不含 MCP 装配）。
 * 结构树永远从文件内容派生；relPath 一律相对 workDir，输出统一用正斜杠。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
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
  /** frontmatter 原始文本块（含 --- 围栏与结尾换行），原样回拼可字节级保留未知字段；无 frontmatter 为空串。 */
  frontmatterRaw: string;
  /** 去掉 frontmatter 后的正文原文。 */
  body: string;
}

/** read_chapter：读取 workDir 内任意文件原文并解析 frontmatter；文件缺失抛错。 */
export function readChapter(workDir: string, relPath: string): ReadChapterResult {
  const abs = resolveInside(workDir, relPath);
  const content = fs.readFileSync(abs, 'utf8');
  const fmEnd = frontmatterEnd(content);
  return {
    content,
    frontmatter: parseFrontmatter(content),
    frontmatterRaw: content.slice(0, fmEnd),
    body: content.slice(fmEnd),
  };
}

/** write_chapter：仅允许 .md 后缀，原子写（tmp + rename），父目录自动创建。
 *  覆盖已存在且内容有变化的文件前，先把旧内容滚动快照进 .novel/history/（安全阀）。 */
export function writeChapter(
  workDir: string,
  relPath: string,
  content: string,
): { ok: true; bytes: number } {
  if (!relPath.toLowerCase().endsWith('.md')) {
    throw new Error(`write_chapter 只允许 .md 文件: ${relPath}`);
  }
  const abs = resolveInside(workDir, relPath);
  snapshotBeforeWrite(workDir, relPath, abs, content);
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

/**
 * search_content：大小写不敏感子串匹配，只搜 manuscript/** /*.md，最多 limit 条。
 * 口径（0004 定稿）：只搜正文——frontmatter 是结构元数据不参与搜索；命中行号按文件实际行号（含 fm 行）。
 */
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
    const fmLen = frontmatterEnd(content);
    // 正文首行在文件中的行号（无 fm 时为 1；fm 块含闭合行、末尾换行）
    const bodyStartLine = content.slice(0, fmLen).split(/\r?\n/).length;
    const lines = content.slice(fmLen).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const idx = line.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      const start = Math.max(0, idx - EXCERPT_CONTEXT);
      const end = Math.min(line.length, idx + query.length + EXCERPT_CONTEXT);
      const excerpt =
        (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '');
      hits.push({ relPath: toPosix(path.join('manuscript', f.rel)), line: bodyStartLine + i, excerpt });
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

// ---------- 安全阀：快照 / 软删 / 导出 ----------

/** 每章保留的滚动快照份数（安全阀口径：保存时快照旧版本）。 */
export const SNAPSHOT_KEEP = 20;

/** 本地时间戳（毫秒级）+ 随机后缀，避免同刻碰撞；字典序即时间序。 */
function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const base =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
  return `${base}-${randomBytes(2).toString('hex')}`;
}

/** relPath 拍平成目录安全的一段（分隔符与盘符冒号替换为 __）。 */
function flattenRel(relPath: string): string {
  return relPath.replace(/[:/\\]+/g, '__').replace(/\.md$/i, '');
}

/** .novel 内部子目录的绝对路径（自动创建）。 */
function novelSubDir(workDir: string, sub: 'history' | 'trash'): string {
  const dir = path.join(assertWorkDir(workDir), '.novel', sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 覆盖写之前快照旧内容到 .novel/history/<拍平的章路径>/<时间戳>.md。
 * 仅当旧文件存在且内容有变化时快照；随后按时间序裁到最近 SNAPSHOT_KEEP 份。
 */
function snapshotBeforeWrite(workDir: string, relPath: string, abs: string, next: string): void {
  let prev: string;
  try {
    prev = fs.readFileSync(abs, 'utf8');
  } catch {
    return; // 新文件无旧版可快照
  }
  if (prev === next) return; // 内容未变不产生重复快照
  const dir = path.join(novelSubDir(workDir, 'history'), flattenRel(relPath));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${stamp()}.md`), prev, 'utf8');
  // 滚动裁剪：文件名以时间戳开头，字典序即时间序
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  for (const stale of names.slice(0, Math.max(0, names.length - SNAPSHOT_KEEP))) {
    fs.rmSync(path.join(dir, stale), { force: true });
  }
}

export interface DeleteChapterResult {
  ok: true;
  /** 软删后相对 workDir 的 trash 路径（正斜杠）。 */
  trashPath: string;
}

/**
 * delete_chapter：软删——把 manuscript 下的 .md 移进 .novel/trash/（时间戳防重名），
 * 永不物理删除；只允许 manuscript/ 内的 .md，拒绝删 .novel 内部与其他文件。
 */
export function deleteChapter(workDir: string, relPath: string): DeleteChapterResult {
  const posix = toPosix(relPath);
  if (!posix.startsWith('manuscript/') || !posix.toLowerCase().endsWith('.md')) {
    throw new Error(`delete_chapter 只允许 manuscript/ 内的 .md 文件: ${relPath}`);
  }
  const abs = resolveInside(workDir, relPath); // 越界在此抛错
  const stampName = `${flattenRel(posix)}-${stamp()}.md`;
  const target = path.join(novelSubDir(workDir, 'trash'), stampName);
  fs.renameSync(abs, target); // 文件不存在时抛错；同卷 rename 原子移动
  return { ok: true, trashPath: toPosix(path.join('.novel', 'trash', stampName)) };
}

export interface ExportTxtResult {
  ok: true;
  /** 导出文件相对 workDir 的路径（正斜杠）。 */
  path: string;
  chapters: number;
  bytes: number;
}

/**
 * export_txt：全稿导出为可直接投出的 txt——按结构树顺序（卷→章），
 * 去 frontmatter、场景标题去掉 ### 标记；章为最小结构（题名+正文），卷名独占一行。
 * 固定写到 workDir 根目录 全稿-<时间戳>.txt（原子写）。
 */
export function exportTxt(workDir: string): ExportTxtResult {
  const volumes = listStructure(workDir);
  const blocks: string[] = [];
  let chapters = 0;
  for (const vol of volumes) {
    if (vol.title !== ROOT_VOLUME_TITLE) blocks.push(vol.title);
    for (const ch of vol.children) {
      const { body } = readChapter(workDir, ch.relPath);
      const text = body
        .split(/\r?\n/)
        .map((line) => line.replace(SCENE_RE, '$1')) // 场景标题去 ###
        .join('\n')
        .replace(/\r\n/g, '\n')
        .trim();
      blocks.push(`${ch.title}\n\n${text}`);
      chapters += 1;
    }
  }
  const content = blocks.join('\n\n\n') + '\n';
  const name = `全稿-${stamp()}.txt`;
  const abs = resolveInside(workDir, name);
  const { bytes } = atomicWrite(abs, content);
  return { ok: true, path: name, chapters, bytes };
}
