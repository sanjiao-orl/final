// 模块职责：进程握手（D2）——core 向壳/外部消费者自报版本与协议契约：
// ready 行（stdout，壳解析接线）与 core-runtime.local.json（文件自报）携带同一组字段，
// 消费者按 protocol 校验兼容性（见 shell/src-tauri/src/lib.rs 的 validate_protocol）。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 协议契约版本（docs/decisions/0007-协议契约-v1.md）。URL 前缀 /v1/ 与此对应，同步递增。 */
export const PROTOCOL_VERSION = 4;

/** 握手自报字段：壳与外部消费者据此校验，不依赖引擎内部类型。 */
export interface RuntimeInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  /** core 包版本（core/package.json，与 config.ts 的 VERSION 同步）。 */
  version: string;
  /** git 短 commit；非 git 环境为 'unknown'（自报用，不参与校验）。 */
  commit: string;
  /** 协议契约版本，校验以它为准。 */
  protocol: number;
}

/** stdout ready 行（单行 JSON，壳逐行解析首个 {"event":"ready"}）。 */
export function readyLine(info: RuntimeInfo): string {
  return JSON.stringify({ event: 'ready', ...info });
}

/** 写 core-runtime.local.json（自报文件；.gitignore 的 *.local 已覆盖）。
 * 目录可能尚不存在（如 CORE_RUNTIME_FILE 指到深层路径），先递归建目录；
 * 写失败抛错由调用方处理——main 在打印 ready 行前调用，失败即视为启动失败，不对外宣告就绪。 */
export function writeRuntimeFile(filePath: string, info: RuntimeInfo): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(info, null, 2) + '\n');
}
