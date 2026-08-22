// 模块职责：集中读取进程环境配置（LLM 预设/用途分配 + legacy 双档回退、.novel 目录、MCP 命令、runtime 文件路径），缺失即抛错，不静默降级。
// 另含进程版本门禁（D2）：Node 版本下限校验、git commit 自报（供握手文件/ready 行携带）、启动期 sqlite 冷备份。
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import corePkg from '../package.json' with { type: 'json' };
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

/** 版本单一事实源：core/package.json version（esbuild 打包时内联，dev 下 tsx 直读）。 */
export const VERSION = corePkg.version;

/** Node 版本门禁下限（与根 package.json engines.node 对齐）：低于此版本直接拒启。 */
export const MIN_NODE_MAJOR = 24;

export type Tier = 'writing' | 'background' | 'review';

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

/**
 * 确定性工具超时秒数缺省值：domain 工具（读写文件/扫描/账本）是本地确定性操作，量级几十秒足够；
 * 与贵档 LLM 的 600s 长超时分开口径——修复台账 config.ts:27「贵档 LLM 600s 才超时、便宜档确定性工具零超时」的倒挂。
 */
export const DEFAULT_TOOL_TIMEOUT_SECONDS = 45;

/** 确定性工具超时秒数：TOOL_TIMEOUT_SECONDS 可覆盖，缺省 DEFAULT_TOOL_TIMEOUT_SECONDS；取值口径同 getLlmTimeoutSeconds。 */
export function getToolTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TOOL_TIMEOUT_SECONDS;
  if (!raw) return DEFAULT_TOOL_TIMEOUT_SECONDS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`TOOL_TIMEOUT_SECONDS 取值非法: ${raw}（需为正数秒数）`);
  }
  return value;
}

/**
 * 启动期 sqlite 冷备份（现状.md 弱点：sessions.sqlite 无备份）：打开库之前把已存在的库文件
 * 覆盖式拷贝一份滚动备份 <dbPath>.bak（单份滚动）。拷贝失败只 warn 不抛错，不阻断启动。
 */
export function backupSqliteFile(dbPath: string, log: Pick<Console, 'warn'> = console): boolean {
  if (!existsSync(dbPath)) return false;
  try {
    copyFileSync(dbPath, `${dbPath}.bak`);
    return true;
  } catch (err) {
    log.warn(`[core] 数据库备份失败（不阻断启动）: ${dbPath} → ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
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

/** 按档位创建模型（legacy 回退路径）：writing 用 model，background/review 用 modelCheap。 */
export function createModelForTier(config: LlmConfig, tier: Tier): LanguageModel {
  const provider = createOpenAICompatible({
    name: 'novel-local',
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    // 宣称支持结构化输出（response_format json_schema）：/v1/review 的 Output.array 依赖它约束线格式；
    // 不宣称时 SDK 会剥掉 responseFormat 仅发提示词，模型产出不受约束 → 解析 502（批三-2 实证踩坑）。
    supportsStructuredOutputs: true,
  });
  return provider.languageModel(tier === 'writing' ? config.model : config.modelCheap);
}

/** 归一化预设 id：大写，非字母数字→下划线（与壳侧注入规则一致）。 */
export function normalizePresetId(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export interface LlmPreset {
  /** 归一化后的 id。 */
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmDescription {
  mode: 'presets' | 'legacy';
  presets: Array<{ id: string; baseUrl: string; model: string; apiKeyMasked: string }>;
  assign: Partial<Record<Tier, string>>;
  effective: Record<Tier, { presetId: string; model: string } | { model: string } | { error: string }>;
  legacy?: { baseUrl: string; model: string; modelCheap: string; apiKeyMasked: string; error?: string };
}

function maskApiKey(apiKey: string): string {
  if (!apiKey) return '';
  return `${Array.from(apiKey).slice(0, 4).join('')}••••`;
}

function resolvePresetForPurpose(presets: Map<string, LlmPreset>, assign: Map<Tier, string>, purpose: Tier) {
  const assigned = assign.get(purpose);
  const id = assigned === undefined ? undefined : normalizePresetId(assigned);
  const preset = id === undefined ? presets.values().next().value : presets.get(id);
  if (assigned !== undefined && !preset) return { error: `指向不存在的预设:${id}` } as const;
  return { presetId: preset!.id, model: preset!.model } as const;
}

/** 返回 core 实际解析出的模型配置；只返回 api key 的前四字符和固定掩码。 */
export function describeLlm(env: NodeJS.ProcessEnv = process.env): LlmDescription {
  const presets = scanLlmPresets(env);
  const assignMap = scanLlmAssign(env);
  const assign: Partial<Record<Tier, string>> = {};
  for (const purpose of ['writing', 'background', 'review'] as Tier[]) {
    const value = assignMap.get(purpose);
    if (value !== undefined) assign[purpose] = normalizePresetId(value);
  }
  if (presets.size > 0) {
    const effective = {} as LlmDescription['effective'];
    for (const purpose of ['writing', 'background', 'review'] as Tier[]) {
      effective[purpose] = resolvePresetForPurpose(presets, assignMap, purpose);
    }
    return {
      mode: 'presets',
      presets: [...presets.values()].map(({ id, baseUrl, model, apiKey }) => ({ id, baseUrl, model, apiKeyMasked: maskApiKey(apiKey) })),
      assign,
      effective,
    };
  }
  const baseUrl = env.LLM_BASE_URL || '';
  const apiKey = env.LLM_API_KEY || '';
  const model = env.LLM_MODEL || '';
  const modelCheap = env.LLM_MODEL_CHEAP || model;
  const missing = [!baseUrl && 'LLM_BASE_URL', !apiKey && 'LLM_API_KEY', !model && 'LLM_MODEL'].filter(Boolean) as string[];
  const legacy = { baseUrl, model, modelCheap, apiKeyMasked: maskApiKey(apiKey), ...(missing.length ? { error: `未配置：缺少 ${missing.join('、')}` } : {}) };
  return { mode: 'legacy', presets: [], assign, effective: { writing: { model }, background: { model: modelCheap }, review: { model: modelCheap } }, legacy };
}

/** 扫描 LLM_PRESET_<ID>_{BASE_URL,API_KEY,MODEL}，组预设表；归一化撞名/缺字段即抛错。 */
export function scanLlmPresets(env: NodeJS.ProcessEnv = process.env): Map<string, LlmPreset> {
  const byId = new Map<string, LlmPreset>();
  const rawById = new Map<string, string>();
  for (const key of Object.keys(env)) {
    const m = /^LLM_PRESET_(.+)_(BASE_URL|API_KEY|MODEL)$/.exec(key);
    if (!m) continue;
    const raw = m[1]!;
    const id = normalizePresetId(raw);
    const prev = rawById.get(id);
    if (prev !== undefined && prev !== raw) {
      throw new Error(`LLM 预设 id 归一化后撞名：${prev} 与 ${raw} 均归一化为 ${id}`);
    }
    rawById.set(id, raw);
    let preset = byId.get(id);
    if (!preset) {
      preset = { id, baseUrl: '', apiKey: '', model: '' };
      byId.set(id, preset);
    }
    const value = env[key] ?? '';
    if (m[2] === 'BASE_URL') preset.baseUrl = value;
    else if (m[2] === 'API_KEY') preset.apiKey = value;
    else preset.model = value;
  }
  for (const preset of byId.values()) {
    const missing: string[] = [];
    if (!preset.baseUrl) missing.push('BASE_URL');
    if (!preset.apiKey) missing.push('API_KEY');
    if (!preset.model) missing.push('MODEL');
    if (missing.length > 0) {
      throw new Error(`LLM 预设 ${preset.id} 缺字段：${missing.map((f) => `LLM_PRESET_${preset.id}_${f}`).join('、')}`);
    }
  }
  return byId;
}

/** 扫描 LLM_ASSIGN_<PURPOSE>：返回用途→预设原始 id；未知用途忽略。 */
export function scanLlmAssign(env: NodeJS.ProcessEnv = process.env): Map<Tier, string> {
  const assign = new Map<Tier, string>();
  for (const key of Object.keys(env)) {
    const m = /^LLM_ASSIGN_(WRITING|BACKGROUND|REVIEW)$/i.exec(key);
    if (!m) continue;
    const purpose = m[1]!.toLowerCase() as Tier;
    const value = env[key];
    if (value !== undefined && value.trim() !== '') assign.set(purpose, value.trim());
  }
  return assign;
}

/** 模型构造缓存：key = baseUrl \n apiKey \n model（同配置同进程只建一次 LanguageModel）。 */
const modelCache = new Map<string, LanguageModel>();

function buildModel(baseUrl: string, apiKey: string, model: string): LanguageModel {
  const key = `${baseUrl}\n${apiKey}\n${model}`;
  const cached = modelCache.get(key);
  if (cached) return cached;
  const provider = createOpenAICompatible({
    name: 'novel-local',
    baseURL: baseUrl,
    apiKey,
    // 同 createModelForTier：宣称支持结构化输出（/v1/review 的 Output.array 依赖，批三-2 实证踩坑）。
    supportsStructuredOutputs: true,
  });
  const languageModel = provider.languageModel(model);
  modelCache.set(key, languageModel);
  return languageModel;
}

/**
 * 按用途取模型：
 * - 有任一 LLM_PRESET_* 环境变量 → 走预设表；用途未分配 → 第一预设；分配指向不存在 id → 抛错。
 * - 无预设 → legacy 四变量：writing→LLM_MODEL，background/review→LLM_MODEL_CHEAP（缺省回退 LLM_MODEL）。
 */
export function modelForPurpose(env: NodeJS.ProcessEnv = process.env, purpose: Tier): LanguageModel {
  const presets = scanLlmPresets(env);
  if (presets.size > 0) {
    const assign = scanLlmAssign(env);
    const resolved = resolvePresetForPurpose(presets, assign, purpose);
    if ('error' in resolved) {
      const assigned = assign.get(purpose)!;
      throw new Error(`LLM_ASSIGN_${purpose.toUpperCase()} 指向不存在的预设：${assigned}`);
    }
    const preset = presets.get(resolved.presetId)!;
    return buildModel(preset.baseUrl, preset.apiKey, resolved.model);
  }
  const config = loadLlmConfig(env);
  return buildModel(config.baseUrl, config.apiKey, purpose === 'writing' ? config.model : config.modelCheap);
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
