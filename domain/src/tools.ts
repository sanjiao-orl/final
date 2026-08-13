/**
 * tools.ts —— 十六个 MCP 工具的业务实现（不含 MCP 装配）。
 * 双侧合并口径：基础工具 7 个（结构/读写/搜索/统计/软删/导出）+ WS-9 scan_quality + A 组 8 工具。
 * 结构树永远从文件内容派生；relPath 一律相对 workDir，输出统一用正斜杠。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { frontmatterEnd, parseFrontmatter } from './frontmatter.js';
import {
  assertWorkDir,
  atomicWrite,
  collectMdFiles,
  resolveInside,
  toPosix,
  type MdFile,
} from './fsutil.js';
export { scanWork as scanQuality } from './qualityScan.js';

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
  /** frontmatter 里的章唯一标识（有才出现）。 */
  id?: string;
  /** frontmatter 里的目标字数（有才出现）。 */
  goal?: number;
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

/**
 * 命名规范：带编号的章文件名/卷目录名（组 1=编号，阿拉伯或汉字均可；组 2=用户标题部分）。
 * 匹配即“带编号”；不匹配的旧文件/旧目录保持原名不动。
 * 新名/重编号一律输出阿拉伯数字编号（第1章·少年 样式）。
 */
const CHAPTER_NAME_RE = /^第(\d+|[一二三四五六七八九十百]+)章[·.、\s]*(.*)$/;
const VOLUME_NAME_RE = /^第(\d+|[一二三四五六七八九十百]+)卷[·.、\s]*(.*)$/;

const CN_DIGIT: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 编号文本（阿拉伯或汉字）→ 数值；无法解析返回 NaN。 */
function numOf(s: string): number {
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  let total = 0;
  let section = 0;
  let num = 0;
  for (const ch of s) {
    if (ch === '百') {
      total += (section + (num || 1)) * 100;
      section = 0;
      num = 0;
    } else if (ch === '十') {
      section += (num || 1) * 10;
      num = 0;
    } else {
      num = CN_DIGIT[ch] ?? 0;
    }
  }
  return total + section + num;
}

/**
 * 章/卷文件名比较：编号感知（汉字/阿拉伯编号按数值排，第一章 < 第二章），
 * 未匹配编号模式的名字按字典序兜底。注意：纯字典序会把 三(U+4E09) 排在 二(U+4E8C) 前，
 * 顺序真相必须按编号数值，否则结构树/重排会乱序。
 */
function compareNames(a: string, b: string, re: RegExp): number {
  const ma = re.exec(a);
  const mb = re.exec(b);
  if (ma && mb) {
    const na = numOf(ma[1]!);
    const nb = numOf(mb[1]!);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  }
  if (ma && !mb) return -1;
  if (!ma && mb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

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
  const c = compareNames(na, nb, CHAPTER_NAME_RE);
  if (c !== 0) return c;
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
  if (fm.id) chapter.id = fm.id;
  if (fm.goal !== undefined) chapter.goal = fm.goal;
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

/** read_chapter：读取 manuscript/ 内的 .md 章文件原文并解析 frontmatter；文件缺失抛错。
 *  例外放开 .novel/trash/ 内的 .md（软删副本），供「拒绝 AI 删章」补偿找回原文用。 */
export function readChapter(workDir: string, relPath: string): ReadChapterResult {
  const abs = resolveInside(workDir, relPath); // 越界在此抛错
  const posix = toPosix(path.relative(assertWorkDir(workDir), abs));
  const isChapter = posix.startsWith('manuscript/');
  const isTrashCopy = posix.startsWith('.novel/trash/');
  if ((!isChapter && !isTrashCopy) || !posix.toLowerCase().endsWith('.md')) {
    throw new Error(`read_chapter 只允许 manuscript/ 或 .novel/trash/ 内的 .md 文件: ${relPath}`);
  }
  const content = fs.readFileSync(abs, 'utf8');
  const fmEnd = frontmatterEnd(content);
  return {
    content,
    frontmatter: parseFrontmatter(content),
    frontmatterRaw: content.slice(0, fmEnd),
    body: content.slice(fmEnd),
  };
}

/** write_chapter：仅允许 manuscript/ 内的 .md 文件，原子写（tmp + rename），父目录自动创建。
 *  覆盖已存在且内容有变化的文件前，先把旧内容滚动快照进 .novel/history/（安全阀）。 */
export function writeChapter(
  workDir: string,
  relPath: string,
  content: string,
): { ok: true; bytes: number } {
  const abs = resolveInside(workDir, relPath); // 越界在此抛错
  const posix = toPosix(path.relative(assertWorkDir(workDir), abs));
  if (!posix.startsWith('manuscript/')) {
    throw new Error(`write_chapter 只允许 manuscript/ 内的 .md 文件: ${relPath}`);
  }
  if (!relPath.toLowerCase().endsWith('.md')) {
    throw new Error(`write_chapter 只允许 .md 文件: ${relPath}`);
  }
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

// ---------- 章节/卷的生产与组织 ----------

/**
 * 同步 frontmatter 的 title 行为 newTitle（文件名去 .md 的完整名，如 第1章·少年）。
 * 其余 frontmatter 字段字节级保留、正文不动；没有 title 行则在开栏 `---` 后插入一行；
 * 完全没有 frontmatter 时在最前补一个完整 fm 块（保证「frontmatter title 与文件名一致」）。
 */
function setFrontmatterTitle(content: string, newTitle: string): string {
  const fmEnd = frontmatterEnd(content);
  if (fmEnd === 0) return `---\ntitle: ${newTitle}\n---\n${content}`;
  const head = content.slice(0, fmEnd); // fm 块（含闭合行），title 行只可能在这里
  const rest = content.slice(fmEnd);
  const replaced = head.replace(/^title:[^\n]*$/m, `title: ${newTitle}`);
  if (replaced !== head) return replaced + rest;
  return head.replace(/^---\r?\n/, `---\ntitle: ${newTitle}\n`) + rest;
}

/** 目录内直接子 .md 文件（按文件名排序），取匹配章名模式的最大编号；无则 0。 */
function maxChapterNumber(dir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // 目录不存在：视为无章
  }
  let max = 0;
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
    const m = CHAPTER_NAME_RE.exec(e.name.replace(/\.md$/i, ''));
    if (m) max = Math.max(max, numOf(m[1]!));
  }
  return max;
}

/** manuscript 下直接子目录（按名排序），取匹配卷名模式的最大编号；无则 0。 */
function maxVolumeNumber(msDir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(msDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let max = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = VOLUME_NAME_RE.exec(e.name);
    if (m) max = Math.max(max, numOf(m[1]!));
  }
  return max;
}

/** 校验“用户标题部分”：不能为空、不能带路径分隔符、不能自带编号前缀。 */
function assertUserTitle(kind: '章' | '卷', title: string): string {
  const t = title.trim();
  if (t === '') throw new Error(`${kind}的 title 不能为空: ${title}`);
  if (t.includes('/') || t.includes('\\')) {
    throw new Error(`${kind}的 title 不能包含路径分隔符: ${t}`);
  }
  if ((kind === '章' ? CHAPTER_NAME_RE : VOLUME_NAME_RE).test(t)) {
    throw new Error(`${kind}的 title 不能带“第X${kind === '章' ? '章' : '卷'}”编号前缀: ${t}`);
  }
  return t;
}

/**
 * create_chapter：新建一章，编号自动接续。
 * volume 省略/空串 → 建在 manuscript 根（散章）；编号 = 卷内（或根）已匹配章名模式的最大编号 + 1。
 * 内容为 A4 定稿模板（title/status/id，goal 传了才写）。同名文件已存在抛错，不覆盖。
 */
export function createChapter(
  workDir: string,
  volume?: string,
  title?: string,
  goal?: number,
): { ok: true; relPath: string } {
  const vol = (volume ?? '').trim();
  if (vol !== '') {
    if (vol === '..' || vol.includes('/') || vol.includes('\\')) {
      throw new Error(`create_chapter 的 volume 不能包含路径分隔符: ${volume}`);
    }
  }
  const t = title === undefined || title.trim() === '' ? '新章' : assertUserTitle('章', title);
  const msDir = path.join(assertWorkDir(workDir), 'manuscript');
  const dir = vol === '' ? msDir : path.join(msDir, vol);
  const n = maxChapterNumber(dir) + 1;
  const name = `第${n}章·${t}`;
  const relPath = toPosix(path.join('manuscript', vol, `${name}.md`));
  const abs = resolveInside(workDir, relPath);
  if (fs.existsSync(abs)) {
    throw new Error(`create_chapter 章文件已存在（不覆盖）: ${relPath}`);
  }
  const lines = ['---', `title: ${name}`, 'status: 草稿', `id: ${randomUUID()}`];
  if (goal !== undefined) lines.push(`goal: ${goal}`);
  const content = lines.join('\n') + '\n---\n\n';
  atomicWrite(abs, content);
  return { ok: true, relPath };
}

/**
 * create_volume：新建一卷。编号 = manuscript 下直接子目录已匹配卷名模式的最大编号 + 1。
 * title 默认 `新卷`；同名卷目录已存在抛错。
 */
export function createVolume(workDir: string, title?: string): { ok: true; volumePath: string } {
  const t = title === undefined || title.trim() === '' ? '新卷' : assertUserTitle('卷', title);
  const msDir = path.join(assertWorkDir(workDir), 'manuscript');
  const n = maxVolumeNumber(msDir) + 1;
  const name = `第${n}卷·${t}`;
  const volumePath = toPosix(path.join('manuscript', name));
  const abs = resolveInside(workDir, volumePath);
  if (fs.existsSync(abs)) {
    throw new Error(`create_volume 卷目录已存在（不覆盖）: ${volumePath}`);
  }
  fs.mkdirSync(abs, { recursive: true });
  return { ok: true, volumePath };
}

/**
 * rename_chapter：章改名（校验同 delete_chapter：只允许 manuscript/ 内的 .md）。
 * 原文件名匹配章名模式 → 保留编号只换标题（第N章·title.md）；不匹配 → 直接用 title.md。
 * 同步 frontmatter 的 title 行；其余字段与正文不动。目标同名已存在抛错。
 */
export function renameChapter(
  workDir: string,
  relPath: string,
  title: string,
): { ok: true; relPath: string } {
  const posix = toPosix(relPath);
  if (!posix.startsWith('manuscript/') || !posix.toLowerCase().endsWith('.md')) {
    throw new Error(`rename_chapter 只允许 manuscript/ 内的 .md 文件: ${relPath}`);
  }
  const t = assertUserTitle('章', title);
  const abs = resolveInside(workDir, relPath);
  const dir = path.dirname(abs);
  const base = path.basename(abs, '.md');
  const m = CHAPTER_NAME_RE.exec(base);
  const newBase = m ? `第${numOf(m[1]!)}章·${t}` : t;
  const newAbs = path.join(dir, `${newBase}.md`);
  if (newAbs === abs) return { ok: true, relPath: posix }; // 名字没变：无事可做
  if (fs.existsSync(newAbs)) {
    throw new Error(`rename_chapter 目标同名已存在（不覆盖）: ${toPosix(path.relative(workDir, newAbs))}`);
  }
  const updated = setFrontmatterTitle(fs.readFileSync(abs, 'utf8'), newBase);
  fs.renameSync(abs, newAbs); // 文件不存在时抛错
  atomicWrite(newAbs, updated);
  return { ok: true, relPath: toPosix(path.join(path.dirname(posix), `${newBase}.md`)) };
}

/**
 * rename_volume：卷改名。volumePath 是 manuscript/ 下的目录 relPath，
 * 拒绝等于 manuscript 本身或非 manuscript/ 前缀；匹配卷名模式 → 保留编号只换标题。
 * 目标同名目录已存在抛错。
 */
export function renameVolume(
  workDir: string,
  volumePath: string,
  title: string,
): { ok: true; volumePath: string } {
  const posix = toPosix(volumePath);
  if (posix === 'manuscript' || posix === 'manuscript/' || !posix.startsWith('manuscript/')) {
    throw new Error(`rename_volume 只允许 manuscript/ 下的目录: ${volumePath}`);
  }
  const t = assertUserTitle('卷', title);
  const abs = resolveInside(workDir, volumePath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`rename_volume 卷目录不存在: ${volumePath}`);
  }
  const parent = path.dirname(abs);
  const base = path.basename(abs);
  const m = VOLUME_NAME_RE.exec(base);
  const newBase = m ? `第${numOf(m[1]!)}卷·${t}` : t;
  const newAbs = path.join(parent, newBase);
  if (newAbs === abs) return { ok: true, volumePath: posix };
  if (fs.existsSync(newAbs)) {
    throw new Error(`rename_volume 目标同名已存在（不覆盖）: ${toPosix(path.relative(workDir, newAbs))}`);
  }
  fs.renameSync(abs, newAbs);
  const dirPosix = posix.slice(0, posix.lastIndexOf('/'));
  return { ok: true, volumePath: toPosix(path.join(dirPosix, newBase)) };
}

export interface RenumberedChapter {
  /** 重排后相对 workDir 的章路径（正斜杠）。 */
  relPath: string;
  /** 章完整名（文件名去 .md，如 第1章·少年）。 */
  title: string;
}

export interface RenumberedVolume {
  /** 重排后相对 workDir 的卷路径（正斜杠）。 */
  volumePath: string;
  /** 卷目录名（如 第1卷·风起）。 */
  title: string;
}

/**
 * 事务化重编号（move_chapter / move_volume 共用）：
 * 先按当前文件顺序取全部项，移走后把目标项插入 toIndex 位置得到最终顺序（移动语义）；
 * 校验所有目标名无冲突（目标已存在即整体拒绝，不改任何文件）；
 * 返回 { plan, finalOrder }，执行时由调用方记录已完成 rename 日志并负责回滚。
 */
function renumberTransactional(
  dir: string,
  base: string,
  order: string[],
  toIndex: number,
  kind: '章' | '卷',
  nameRe: RegExp,
): { plan: Array<{ from: string; to: string }>; finalOrder: string[] } {
  const idx = order.indexOf(base);
  if (idx === -1) throw new Error(`move_${kind === '章' ? 'chapter' : 'volume'} 找不到目标: ${base}`);
  if (toIndex >= order.length || toIndex < 0) {
    throw new Error(
      `move_${kind === '章' ? 'chapter' : 'volume'} 不支持跨${kind === '章' ? '卷' : '目录'}移动：toIndex ${toIndex} 越界（共 ${order.length} 项）`,
    );
  }
  const rest = order.filter((n) => n !== base);
  const finalOrder = [...rest.slice(0, toIndex), base, ...rest.slice(toIndex)];

  // 计划：最终顺序里每个匹配命名模式的项重命名为 第{i+1}{章|卷}·用户标题
  const plan: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < finalOrder.length; i++) {
    const name = finalOrder[i]!;
    const noExt = name.replace(/\.md$/i, '');
    const m = nameRe.exec(noExt);
    if (!m) continue; // 不匹配的旧名保持原名不动
    const newBase = `第${i + 1}${kind === '章' ? '章' : '卷'}·${m[2]!}`;
    if (newBase === noExt) continue; // 名字已正确
    plan.push({ from: name, to: kind === '章' ? `${newBase}.md` : newBase });
  }

  // 冲突校验：目标名已存在 → 整体拒绝，不改任何文件
  for (const p of plan) {
    if (fs.existsSync(path.join(dir, p.to))) {
      throw new Error(`move_${kind === '章' ? 'chapter' : 'volume'} 目标名冲突，整体拒绝（未改动任何文件）: ${p.to}`);
    }
  }
  return { plan, finalOrder };
}

/** 逆序回滚已完成的 rename；任一回滚失败都抛错说明（不掩盖回滚失败）。 */
function rollbackRenames(dir: string, done: Array<{ from: string; to: string }>): void {
  for (const { from, to } of [...done].reverse()) {
    try {
      fs.renameSync(path.join(dir, to), path.join(dir, from));
    } catch (err) {
      throw new Error(`move 回滚失败（${to} → ${from}）: ${String(err)}`);
    }
  }
}

/**
 * move_chapter：卷内重排。把 relPath 章移到同卷内目标位置（0 起始索引，
 * 语义=移动后该章在卷内最终顺序中的位置），事务化重编号为 第1章..第N章（按最终顺序），
 * frontmatter title 行同步；不匹配章名模式的章名与 title 不动。不支持跨卷移动（toIndex 越界抛错）。
 */
export function moveChapter(
  workDir: string,
  relPath: string,
  toIndex: number,
): { ok: true; renumbered: RenumberedChapter[] } {
  const posix = toPosix(relPath);
  if (!posix.startsWith('manuscript/') || !posix.toLowerCase().endsWith('.md')) {
    throw new Error(`move_chapter 只允许 manuscript/ 内的 .md 文件: ${relPath}`);
  }
  if (!Number.isInteger(toIndex) || toIndex < 0) {
    throw new Error(`move_chapter toIndex 必须是非负整数: ${toIndex}`);
  }
  const abs = resolveInside(workDir, relPath);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new Error(`move_chapter 章文件不存在: ${relPath}`);
  }
  const names = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map((e) => e.name)
    .sort((a, b) => compareNames(a, b, CHAPTER_NAME_RE));
  if (!names.includes(base)) throw new Error(`move_chapter 章不在卷内: ${relPath}`);

  const { plan, finalOrder } = renumberTransactional(dir, base, names, toIndex, '章', CHAPTER_NAME_RE);

  // 执行：先全部改名，再同步 fm title；失败逆序回滚（把已改回原名）
  const done: Array<{ from: string; to: string }> = [];
  try {
    for (const p of plan) {
      fs.renameSync(path.join(dir, p.from), path.join(dir, p.to));
      done.push(p);
    }
    for (const p of plan) {
      const toAbs = path.join(dir, p.to);
      const updated = setFrontmatterTitle(fs.readFileSync(toAbs, 'utf8'), p.to.replace(/\.md$/i, ''));
      atomicWrite(toAbs, updated);
    }
  } catch (err) {
    rollbackRenames(dir, done);
    throw err;
  }

  const byFrom = new Map(plan.map((p) => [p.from, p.to]));
  return {
    ok: true,
    renumbered: finalOrder.map((name) => ({
      relPath: toPosix(path.join(path.dirname(posix), byFrom.get(name) ?? name)),
      title: (byFrom.get(name) ?? name).replace(/\.md$/i, ''),
    })),
  };
}

/**
 * move_volume：卷排序。把 volumePath 卷移到 manuscript 下第 toIndex 位（0 起始），
 * 匹配卷名模式的目录重命名为 第{i+1}卷·用户标题；事务化（同 move_chapter 的回滚机制）。
 * 卷名不带编号（未匹配）时目录名不变，但排序仍按文件名。
 */
export function moveVolume(
  workDir: string,
  volumePath: string,
  toIndex: number,
): { ok: true; renumbered: RenumberedVolume[] } {
  const posix = toPosix(volumePath);
  if (posix === 'manuscript' || posix === 'manuscript/' || !posix.startsWith('manuscript/')) {
    throw new Error(`move_volume 只允许 manuscript/ 下的目录: ${volumePath}`);
  }
  if (!Number.isInteger(toIndex) || toIndex < 0) {
    throw new Error(`move_volume toIndex 必须是非负整数: ${toIndex}`);
  }
  const msDir = path.join(assertWorkDir(workDir), 'manuscript');
  const abs = resolveInside(workDir, volumePath);
  if (path.dirname(abs) !== msDir) {
    throw new Error(`move_volume 只支持对 manuscript 直接子目录（卷）排序: ${volumePath}`);
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`move_volume 卷目录不存在: ${volumePath}`);
  }
  const base = path.basename(abs);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(msDir, { withFileTypes: true });
  } catch {
    throw new Error(`move_volume 卷目录不存在: ${volumePath}`);
  }
  const names = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => compareNames(a, b, VOLUME_NAME_RE));
  if (!names.includes(base)) throw new Error(`move_volume 卷不在 manuscript 下: ${volumePath}`);

  const { plan, finalOrder } = renumberTransactional(msDir, base, names, toIndex, '卷', VOLUME_NAME_RE);

  const done: Array<{ from: string; to: string }> = [];
  try {
    for (const p of plan) {
      fs.renameSync(path.join(msDir, p.from), path.join(msDir, p.to));
      done.push(p);
    }
  } catch (err) {
    rollbackRenames(msDir, done);
    throw err;
  }

  const byFrom = new Map(plan.map((p) => [p.from, p.to]));
  return {
    ok: true,
    renumbered: finalOrder.map((name) => ({
      volumePath: toPosix(path.join('manuscript', byFrom.get(name) ?? name)),
      title: byFrom.get(name) ?? name,
    })),
  };
}

// ---------- 历史快照读取 ----------

export interface SnapshotFile {
  /** 相对 workDir 的快照路径（正斜杠），如 .novel/history/manuscript__卷一__第一章/20240101-000000000-aa.md。 */
  path: string;
  /** 快照文件名（时间戳段，原样返回文件名即可）。 */
  timestamp: string;
}

export interface SnapshotGroup {
  /** 章 relPath 拍平后的子目录名（不带 relPath 时按此分组）。 */
  chapterFlatten: string;
  files: SnapshotFile[];
}

/** 目录下 .md 快照文件名倒序（时间戳文件名字典序即时间序，新在前）。 */
function readSnapshotFiles(workDir: string, dir: string): SnapshotFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // 目录不存在：无快照
  }
  return names
    .filter((n) => n.toLowerCase().endsWith('.md'))
    .sort()
    .reverse()
    .map((n) => ({
      path: toPosix(path.relative(assertWorkDir(workDir), path.join(dir, n))),
      timestamp: n,
    }));
}

/**
 * list_snapshots：列 .novel/history/ 下的历史快照。
 * 给 relPath → 该章（拍平目录推导同 flattenRel）的 { snapshots: [{ path, timestamp }] }；
 * 不给 → 按拍平目录分组 { snapshots: [{ chapterFlatten, files }] }。
 * 无 history 目录返回空数组，不抛错；时间戳文件名倒序（新在前）。
 */
export function listSnapshots(workDir: string, relPath: string): { snapshots: SnapshotFile[] };
export function listSnapshots(workDir: string, relPath?: string): { snapshots: SnapshotGroup[] };
export function listSnapshots(
  workDir: string,
  relPath?: string,
): { snapshots: SnapshotFile[] } | { snapshots: SnapshotGroup[] } {
  const root = path.join(assertWorkDir(workDir), '.novel', 'history');
  if (relPath !== undefined) {
    return { snapshots: readSnapshotFiles(workDir, path.join(root, flattenRel(toPosix(relPath)))) };
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { snapshots: [] }; // 无 history 目录
  }
  const groups: SnapshotGroup[] = [];
  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const files = readSnapshotFiles(workDir, path.join(root, e.name));
    if (files.length === 0) continue;
    groups.push({ chapterFlatten: e.name, files });
  }
  return { snapshots: groups };
}

/**
 * read_snapshot：读 .novel/history/ 下的快照 .md 原文。
 * snapshotPath 必须解析后仍在 workDir 内、以 .md 结尾且位于 .novel/history/ 下（防止任意文件读取）。
 */
export function readSnapshot(workDir: string, snapshotPath: string): { ok: true; content: string } {
  const posix = toPosix(snapshotPath);
  if (!posix.toLowerCase().endsWith('.md')) {
    throw new Error(`read_snapshot 只允许 .md 快照文件: ${snapshotPath}`);
  }
  if (!posix.startsWith('.novel/history/')) {
    throw new Error(`read_snapshot 只允许读取 .novel/history/ 内的快照: ${snapshotPath}`);
  }
  const abs = resolveInside(workDir, snapshotPath); // 越界在此抛错
  return { ok: true, content: fs.readFileSync(abs, 'utf8') };
}
