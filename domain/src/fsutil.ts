/**
 * fsutil.ts —— 路径守卫、原子写、manuscript 文件收集等底层文件操作。
 * 安全不变量：所有 relPath 解析后必须仍在 workDir 内，越界一律抛错。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 校验 workDir 为绝对路径并规范化。 */
export function assertWorkDir(workDir: string): string {
  if (!path.isAbsolute(workDir)) {
    throw new Error(`workDir 必须是绝对路径: ${workDir}`);
  }
  return path.resolve(workDir);
}

/**
 * 把 relPath 相对 workDir 解析为绝对路径，同时做越界守卫。
 * 拒绝：绝对路径 relPath、`..` 逃逸、跨盘符（Windows）。返回的路径保证在 workDir 内。
 */
export function resolveInside(workDir: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new Error(`relPath 不能是绝对路径: ${relPath}`);
  }
  const base = assertWorkDir(workDir);
  const target = path.resolve(base, relPath);
  const rel = path.relative(base, target); // win32 下 path.relative 按大小写不敏感比较公共前缀
  if (rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
    return target;
  }
  throw new Error(`relPath 越界(必须位于 workDir 内): ${relPath}`);
}

/**
 * 归一化路径解析：先 resolveInside 规范化（压入 workDir 内 + 消解 ..），
 * 再一次性返回 { abs, posix }——abs 为绝对路径，posix 为相对 workDir 的正斜杠路径。
 * 安全契约：所有按相对路径操作的工具必须"先过它、再对 posix 做前缀白名单判断"，
 * 杜绝"用未归一化原始 relPath 做 startsWith 前缀检查、之后才 resolveInside" 的口径错位
 * （例如 `manuscript/../.novel/ledger.md` 的原始串以 manuscript/ 开头、归一化后其实是 .novel/ 路径）。
 *
 * 附带符号链接逃逸防御：从目标（可能自身不存在）向上找最近存在的祖先，realpath 之，
 * 确认 realpath 落点仍在 workDir 内，否则抛中文错——防止写入/读取路径经仓内 symlink/junction
 * 指向作品目录外（collectMdFiles 读侧已跳 symlink，本函数补上写侧/单文件操作的落点校验）。
 * 每操作只做一次，量级可接受。
 */
export function resolveInsidePosix(
  workDir: string,
  relPath: string,
): { abs: string; posix: string } {
  const base = assertWorkDir(workDir);
  const abs = resolveInside(base, relPath);
  const realBase = fs.realpathSync(base); // workDir 一定存在，realpath 必成功
  // 从目标向上找最近存在的祖先；依赖 realBase 与 realProbe 同为 realpath 结果（Windows 大小写一致）
  let probe = abs;
  for (;;) {
    let realProbe: string;
    try {
      realProbe = fs.realpathSync(probe);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') {
        const parent = path.dirname(probe);
        if (parent === probe) break; // 一路到根仍不存在：整条都在仓内，放行
        probe = parent;
        continue;
      }
      throw err;
    }
    // 复用 resolveInside 的"仍在 base 内"判定语义（win32 下比较公共前缀大小写不敏感）
    const rel = path.relative(realBase, realProbe);
    const inside =
      rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    if (!inside) {
      throw new Error(`路径经符号链接指向作品目录外: ${relPath}`);
    }
    break;
  }
  return { abs, posix: toPosix(path.relative(base, abs)) };
}

/** 单个 .md 文件（相对 manuscript 的 rel 与绝对路径）。 */
export interface MdFile {
  /** 相对 manuscript 的路径（原生分隔符）。 */
  rel: string;
  /** 绝对路径。 */
  abs: string;
}

/** 被跳过的文件/目录及其原因（扫描类工具的 skipped 列表元素；additive 字段，不改既有字段语义）。 */
export interface SkippedEntry {
  /** 被跳过者相对 workDir 的路径（正斜杠）。 */
  path: string;
  /** 跳过原因（错误消息文本）。 */
  reason: string;
}

/** 错误 → 一句话消息文本（warn 与 skipped.reason 共用口径）。 */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 递归收集 manuscript 下的所有 .md 文件（符号链接一律跳过，防止链接逃逸），
 * 按 rel 排序保证输出稳定；manuscript 不存在时返回空数组。
 * 目录不可读与符号链接条目均不再静默：console.warn 带路径与错误，并通过可选 onSkip 上报
 * （rel 相对 manuscriptDir，'' 表示 manuscript 根），供扫描类工具组装 skipped 列表。
 */
export function collectMdFiles(
  manuscriptDir: string,
  onSkip?: (rel: string, err: unknown) => void,
): MdFile[] {
  const out: MdFile[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // 目录不存在：维持「当没有文件处理」的既有语义
      console.warn(`[fsutil] 目录不可读已跳过: ${dir}（${errText(err)}）`);
      onSkip?.(rel, err);
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) {
        // 防符号链接逃逸：不再静默 continue——warn + onSkip 上报，扫描类工具据此计入 skipped（章序/字数/搜索不静默漏章）
        const relName = path.join(rel, e.name);
        console.warn(`[fsutil] 符号链接已跳过: ${path.join(manuscriptDir, relName)}（防链接逃逸）`);
        onSkip?.(relName, new Error('符号链接已跳过（防链接逃逸）'));
        continue;
      }
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), path.join(rel, e.name));
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.push({ rel: path.join(rel, e.name), abs: path.join(dir, e.name) });
      }
    }
  };
  walk(manuscriptDir, '');
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/**
 * 命名规范：带编号的章文件名/卷目录名（组 1=编号，阿拉伯或汉字均可；组 2=用户标题部分）。
 * 匹配即“带编号”；不匹配的旧文件/旧目录保持原名不动。
 */
export const CHAPTER_NAME_RE = /^第(\d+|[一二三四五六七八九十百]+)章[·.、\s]*(.*)$/;
export const VOLUME_NAME_RE = /^第(\d+|[一二三四五六七八九十百]+)卷[·.、\s]*(.*)$/;

const CN_DIGIT: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 编号文本（阿拉伯或汉字）→ 数值；无法解析返回 NaN。 */
export function numOf(s: string): number {
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
 * 名称比较：编号感知（汉字/阿拉伯编号按数值排，第一章 < 第二章），
 * 未匹配编号模式的名字按字典序兜底。注意：纯字典序会把 三(U+4E09) 排在 二(U+4E8C) 前，
 * 顺序真相必须按编号数值，否则结构树/重排/账本章序会乱序。scan_quality 的书级连续章判定也复用此比较器。
 */
export function compareNames(a: string, b: string, re: RegExp): number {
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

/** MdFile 按文件名比较（编号感知，第2章 < 第10章），同名按完整 rel 兜底保证稳定。 */
export function compareMdFileName(a: MdFile, b: MdFile): number {
  const c = compareNames(path.basename(a.rel), path.basename(b.rel), CHAPTER_NAME_RE);
  if (c !== 0) return c;
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

/** 编号感知排序（返回新数组，不改入参）：章文件按文件名数值序，非 collectMdFiles 的字典序。 */
export function sortMdFilesNumberAware(files: MdFile[]): MdFile[] {
  return [...files].sort(compareMdFileName);
}

/**
 * 原子写：同目录临时文件 + rename 覆盖，父目录自动 mkdir -p。
 * 返回写入的 UTF-8 字节数。失败时清理临时文件并抛错。
 */
export function atomicWrite(target: string, content: string): { ok: true; bytes: number } {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, target); // Node 在 Windows 上 rename 同样可覆盖已存在文件
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw err;
  }
  return { ok: true, bytes: Buffer.byteLength(content, 'utf8') };
}

/** relPath 统一输出为正斜杠，跨平台稳定。 */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}
