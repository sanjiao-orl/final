// 模块职责：集中读取进程环境配置（LLM 双档模型、.novel 目录、MCP 命令、runtime 文件路径），缺失即抛错，不静默降级。
import path from 'node:path';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

/** 与 core/package.json version 保持同步。 */
export const VERSION = '0.1.0';

export type Tier = 'writing' | 'background';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  /** writing 档模型。 */
  model: string;
  /** background 档模型，缺省回退 model。 */
  modelCheap: string;
}

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
 */
export function getDomainMcpCommand(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const raw = (env.MCP_DOMAIN_CMD || 'npx tsx ../domain/src/server.ts').trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  const command = parts[0] ?? 'npx tsx ../domain/src/server.ts';
  return { command, args: parts.slice(1) };
}

/** runtime 信息文件：默认仓库根 core-runtime.local.json（根 .gitignore 的 *.local 已覆盖）。 */
export function getRuntimeFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CORE_RUNTIME_FILE || path.resolve(import.meta.dirname, '..', '..', 'core-runtime.local.json');
}
