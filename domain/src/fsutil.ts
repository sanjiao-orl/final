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

/** 单个 .md 文件（相对 manuscript 的 rel 与绝对路径）。 */
export interface MdFile {
  /** 相对 manuscript 的路径（原生分隔符）。 */
  rel: string;
  /** 绝对路径。 */
  abs: string;
}

/**
 * 递归收集 manuscript 下的所有 .md 文件（符号链接一律跳过，防止链接逃逸），
 * 按 rel 排序保证输出稳定；manuscript 不存在时返回空数组。
 */
export function collectMdFiles(manuscriptDir: string): MdFile[] {
  const out: MdFile[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在或不可读：当没有文件处理
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // 防符号链接逃逸
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
