// 模块职责：workDir 归一化清洗（chat/rewrite 单源共用，不复制）——
// path.resolve 归一并校验存在且为目录，不合法抛 HttpError(400)。
// 控制字符已在各通道 schema 层拒绝（注入面：目录名原样拼进系统提示，控制字符可破出提示行），这里兜底路径合法性。
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './http.js';

export function normalizeWorkDir(raw: string): string {
  const resolved = path.resolve(raw);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new HttpError(400, `workDir 路径不存在: ${raw}`);
  }
  if (!stat.isDirectory()) {
    throw new HttpError(400, `workDir 不是目录: ${raw}`);
  }
  return resolved;
}