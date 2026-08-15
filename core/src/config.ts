// 模块职责：集中读取进程环境配置（LLM 双档模型、.novel 目录、MCP 命令、runtime 文件路径），缺失即抛错，不静默降级。
// 另含进程版本门禁（D2）：Node 版本下限校验、git commit 自报（供握手文件/ready 行携带）。
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

/** 与 core/package.json version 保持同步。 */
export const VERSION = '0.1.3';

/** Node 版本门禁下限（与根 package.json engines.node 对齐）：低于此版本直接拒启。 */
export const MIN_NODE_MAJOR = 24;

export type Tier = 'writing' | 'background';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  /** writing 档模型。 */
  model: string;
  /** background 档模型，缺省回退 model。 */
  modelCheap: string;
}

/** LLM 服务端超时秒数缺省值：provider 挂起时请求最多挂这么久；多步工具轮在慢 provider 下耗时可能很长，取 10 分钟。 */
export const DEFAULT_LLM_TIMEOUT_SECONDS = 600;

/** 构造即校验：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 缺任一即抛错。 */
export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const baseUrl = env.LLM_BASE_URL;
  const apiKey = env.LLM_API_KEY;
  const model = env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error('缺少 LLM 环境变量：需要 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL（LLM_MODEL_CHEAP 可选）');
  }
  return { baseUrl, apiKey, model, modelCheap: env.LLM_MODEL_CHEAP || model };
}

/** LLM 服务端超时秒数：LLM_TIMEOUT_SECONDS 可覆盖，缺省 DEFAULT_LLM_TIMEOUT_SECONDS；取值必须为正数秒数。 */
export function getLlmTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LLM_TIMEOUT_SECONDS;
  if (!raw) return DEFAULT_LLM_TIMEOUT_SECONDS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`LLM_TIMEOUT_SECONDS 取值非法: ${raw}（需为正数秒数）`);
  }
  return value;
}

/** 按档位创建模型：writing 用 LLM_MODEL，background 用 LLM_MODEL_CHEAP。 */
export function createModelForTier(config: LlmConfig, tier: Tier): LanguageModel {
  const provider = createOpenAICompatible({
    name: 'novel-local',
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  });
  return provider.languageModel(tier === 'background' ? config.modelCheap : config.model);
}

/** .novel 目录：NOVEL_DIR 可配，缺省 process.cwd()/.novel，自动建目录由调用方负责。 */
export function getNovelDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.NOVEL_DIR || path.join(process.cwd(), '.novel');
}

/**
 * domain MCP 启动命令：MCP_DOMAIN_CMD 可覆盖，缺省 "npx tsx ../domain/src/server.ts"，
 * 相对路径以 core 包目录为基准解析（见 mcp.ts 的 cwd 设置）。
 * 按空白拆分成 command+args，支持双引号分段（如 "C:\Program Files\node.exe" script.js），
 * 引号内空白不分割、引号本身剥掉；不处理转义引号——本场景只有本地命令路径。
 */
export function getDomainMcpCommand(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const raw = (env.MCP_DOMAIN_CMD || 'npx tsx ../domain/src/server.ts').trim();
  const parts = splitCommandLine(raw);
  const command = parts[0] ?? 'npx tsx ../domain/src/server.ts';
  return { command, args: parts.slice(1) };
}

/** 按空白拆分命令行，支持双引号分段；连续空白跳过，空串（含空引号对）不产出片段。 */
function splitCommandLine(raw: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  for (const ch of raw) {
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ' ' || ch === '\t') {
      if (inQuote) current += ch;
      else if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** runtime 信息文件：默认仓库根 core-runtime.local.json（根 .gitignore 的 *.local 已覆盖）。 */
export function getRuntimeFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CORE_RUNTIME_FILE || path.resolve(import.meta.dirname, '..', '..', 'core-runtime.local.json');
}

/**
 * Node 版本门禁（D2）：主版本低于 MIN_NODE_MAJOR 即抛错拒启。
 * 版本串可注入以便测试（缺省读 process.versions.node）。
 */
export function assertNodeVersion(version = process.versions.node): void {
  const major = Number(version.split('.')[0]);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    throw new Error(`Node 版本过低：当前 ${version}，需要 >= ${MIN_NODE_MAJOR}（根 package.json engines 对齐）`);
  }
}

/**
 * git 短 commit 自报（D2）：在 cwd（缺省 core 包目录）取 `git rev-parse --short HEAD`；
 * 非 git 环境/命令失败回退 'unknown'——commit 仅自报展示，不参与协议校验。
 */
export function getGitCommit(cwd = path.resolve(import.meta.dirname, '..')): string {
  try {
    // 注意：不显式传 stdio 数组——实测显式 stdio 下 execFileSync 返回 null 而非 stdout（Node 行为）。
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' });
    const commit = out.trim();
    return commit || 'unknown';
  } catch {
    return 'unknown';
  }
}
