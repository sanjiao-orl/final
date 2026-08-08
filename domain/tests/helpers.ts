/**
 * helpers.ts —— 测试夹具：临时作品目录（绝对路径）+ 树状写文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

const dirs: string[] = [];

/** 建一个临时空作品目录（绝对路径），测试结束自动清理。 */
export function makeWorkDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-test-'));
  dirs.push(dir);
  return dir;
}

/** 按 { 相对路径: 内容 } 一次写入文件树（父目录自动创建）。 */
export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
