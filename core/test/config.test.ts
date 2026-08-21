// 测试：环境配置——缺失抛错、双档模型映射、默认/覆盖取值；D2 握手门禁——Node 版本下限、git commit 自报。
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNodeVersion,
  createModelForTier,
  DEFAULT_LLM_TIMEOUT_SECONDS,
  describeLlm,
  getDomainMcpCommand,
  getGitCommit,
  getLlmTimeoutSeconds,
  getNovelDir,
  getRuntimeFilePath,
  loadLlmConfig,
  MIN_NODE_MAJOR,
  modelForPurpose,
  normalizePresetId,
  scanLlmAssign,
  scanLlmPresets,
} from '../src/config.js';

const FULL_ENV = { LLM_BASE_URL: 'http://127.0.0.1:11434/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm1', LLM_MODEL_CHEAP: 'm2' };

/** 三个预设：main-writer / bg-helper / reviewer；归一化后依次为 MAIN_WRITER / BG_HELPER / REVIEWER。 */
const PRESET_ENV = {
  LLM_PRESET_main_writer_BASE_URL: 'http://w/v1',
  LLM_PRESET_main_writer_API_KEY: 'kw',
  LLM_PRESET_main_writer_MODEL: 'writer-m',
  'LLM_PRESET_bg-helper_BASE_URL': 'http://b/v1',
  'LLM_PRESET_bg-helper_API_KEY': 'kb',
  'LLM_PRESET_bg-helper_MODEL': 'bg-m',
  LLM_PRESET_reviewer_BASE_URL: 'http://r/v1',
  LLM_PRESET_reviewer_API_KEY: 'kr',
  LLM_PRESET_reviewer_MODEL: 'review-m',
};

describe('config', () => {
  it('LLM 三要素缺任一即抛错，不静默降级', () => {
    expect(() => loadLlmConfig({})).toThrow();
    expect(() => loadLlmConfig({ LLM_BASE_URL: 'http://x' })).toThrow();
    expect(() => loadLlmConfig({ LLM_BASE_URL: 'http://x', LLM_API_KEY: 'k' })).toThrow();
    expect(() => loadLlmConfig({ LLM_BASE_URL: 'http://x', LLM_API_KEY: 'k', LLM_MODEL: 'm' })).not.toThrow();
  });

  it('modelCheap 缺省回退 model', () => {
    const config = loadLlmConfig({ LLM_BASE_URL: 'http://x', LLM_API_KEY: 'k', LLM_MODEL: 'm' });
    expect(config.modelCheap).toBe('m');
    expect(loadLlmConfig(FULL_ENV).modelCheap).toBe('m2');
  });

  it('LLM 超时秒数：默认 120s，可用 LLM_TIMEOUT_SECONDS 覆盖，非法取值抛错', () => {
    expect(getLlmTimeoutSeconds({})).toBe(DEFAULT_LLM_TIMEOUT_SECONDS);
    expect(getLlmTimeoutSeconds({ LLM_TIMEOUT_SECONDS: '30' })).toBe(30);
    expect(getLlmTimeoutSeconds({ LLM_TIMEOUT_SECONDS: '0.1' })).toBe(0.1);
    expect(() => getLlmTimeoutSeconds({ LLM_TIMEOUT_SECONDS: '0' })).toThrow(/LLM_TIMEOUT_SECONDS 取值非法/);
    expect(() => getLlmTimeoutSeconds({ LLM_TIMEOUT_SECONDS: 'abc' })).toThrow(/LLM_TIMEOUT_SECONDS 取值非法/);
  });

  it('三档模型映射（legacy）：writing 用 LLM_MODEL，background/review 用 LLM_MODEL_CHEAP', () => {
    const config = loadLlmConfig(FULL_ENV);
    const modelId = (model: { modelId: string }): string => model.modelId;
    expect(modelId(createModelForTier(config, 'writing') as { modelId: string })).toBe('m1');
    expect(modelId(createModelForTier(config, 'background') as { modelId: string })).toBe('m2');
    expect(modelId(createModelForTier(config, 'review') as { modelId: string })).toBe('m2');
  });

  it('预设 id 归一化：大写、非字母数字→下划线', () => {
    expect(normalizePresetId('main-writer')).toBe('MAIN_WRITER');
    expect(normalizePresetId('Reviewer 2')).toBe('REVIEWER_2');
    expect(normalizePresetId('already_NORM')).toBe('ALREADY_NORM');
  });

  it('预设表解析：LLM_PRESET_<ID>_* 按归一化 id 组表', () => {
    const presets = scanLlmPresets(PRESET_ENV);
    expect([...presets.keys()]).toEqual(['MAIN_WRITER', 'BG_HELPER', 'REVIEWER']);
    expect(presets.get('MAIN_WRITER')).toEqual({
      id: 'MAIN_WRITER',
      baseUrl: 'http://w/v1',
      apiKey: 'kw',
      model: 'writer-m',
    });
    expect(presets.get('BG_HELPER')).toEqual({
      id: 'BG_HELPER',
      baseUrl: 'http://b/v1',
      apiKey: 'kb',
      model: 'bg-m',
    });
  });

  it('预设表解析：归一化后撞名 / 缺字段均启动报错', () => {
    expect(() =>
      scanLlmPresets({
        LLM_PRESET_a_b_BASE_URL: 'http://x',
        LLM_PRESET_a_b_API_KEY: 'k',
        LLM_PRESET_a_b_MODEL: 'm1',
        LLM_PRESET_a_b_BASE_URL_EXTRA: 'x',
        'LLM_PRESET_a-b_BASE_URL': 'http://y',
        'LLM_PRESET_a-b_API_KEY': 'k',
        'LLM_PRESET_a-b_MODEL': 'm2',
      }),
    ).toThrow(/归一化后撞名/);
    expect(() => scanLlmPresets({ LLM_PRESET_x_BASE_URL: 'http://x' })).toThrow(/缺字段/);
  });

  it('assign 解析：有效用途收表，空白值忽略，未知用途忽略', () => {
    const assign = scanLlmAssign({
      LLM_ASSIGN_WRITING: 'main-writer',
      LLM_ASSIGN_BACKGROUND: 'bg-helper',
      LLM_ASSIGN_REVIEW: '   ',
      LLM_ASSIGN_OTHER: 'ignored',
    });
    expect(assign.get('writing')).toBe('main-writer');
    expect(assign.get('background')).toBe('bg-helper');
    expect(assign.has('review')).toBe(false);
  });

  it('modelForPurpose：有预设走 assign，未分配用途回退第一预设，assign 指向不存在 id 报错', () => {
    const modelId = (model: { modelId: string }): string => model.modelId;
    const env = {
      ...PRESET_ENV,
      LLM_ASSIGN_WRITING: 'main-writer',
      LLM_ASSIGN_BACKGROUND: 'bg-helper',
      LLM_ASSIGN_REVIEW: 'reviewer',
    };
    expect(modelId(modelForPurpose(env, 'writing') as { modelId: string })).toBe('writer-m');
    expect(modelId(modelForPurpose(env, 'background') as { modelId: string })).toBe('bg-m');
    expect(modelId(modelForPurpose(env, 'review') as { modelId: string })).toBe('review-m');

    // 未分配用途：回退第一预设（按环境变量扫描顺序）
    expect(modelId(modelForPurpose(PRESET_ENV, 'review') as { modelId: string })).toBe('writer-m');

    expect(() => modelForPurpose({ ...PRESET_ENV, LLM_ASSIGN_REVIEW: 'missing' }, 'review')).toThrow(
      /LLM_ASSIGN_REVIEW 指向不存在的预设/,
    );
  });

  it('describeLlm：预设真值、回退、错误与 key 打码', () => {
    const result = describeLlm({ ...PRESET_ENV, LLM_ASSIGN_WRITING: 'main-writer', LLM_ASSIGN_BACKGROUND: 'missing' });
    expect(result.mode).toBe('presets');
    expect(result.presets).toHaveLength(3);
    expect(result.assign).toEqual({ writing: 'MAIN_WRITER', background: 'MISSING' });
    expect(result.effective.writing).toEqual({ presetId: 'MAIN_WRITER', model: 'writer-m' });
    expect(result.effective.review).toEqual({ presetId: 'MAIN_WRITER', model: 'writer-m' });
    expect(result.effective.background).toEqual({ error: '指向不存在的预设:MISSING' });
    expect(result.presets.find((preset) => preset.id === 'MAIN_WRITER')?.apiKeyMasked).toBe('kw••••');
    expect(result.presets.find((preset) => preset.id === 'MAIN_WRITER')?.apiKeyMasked).not.toContain('secret');
  });

  it('describeLlm：legacy 齐全与缺失均不抛错', () => {
    expect(describeLlm(FULL_ENV)).toMatchObject({ mode: 'legacy', effective: { writing: { model: 'm1' }, background: { model: 'm2' }, review: { model: 'm2' } } });
    expect(describeLlm({ LLM_BASE_URL: 'http://x', LLM_API_KEY: 'k' }).legacy?.error).toContain('LLM_MODEL');
  });

  it('modelForPurpose：无预设时完全按 legacy 四变量，缺变量维持报错语义', () => {
    const modelId = (model: { modelId: string }): string => model.modelId;
    expect(modelId(modelForPurpose(FULL_ENV, 'writing') as { modelId: string })).toBe('m1');
    expect(modelId(modelForPurpose(FULL_ENV, 'background') as { modelId: string })).toBe('m2');
    expect(modelId(modelForPurpose(FULL_ENV, 'review') as { modelId: string })).toBe('m2');
    expect(() => modelForPurpose({ LLM_BASE_URL: 'http://x', LLM_API_KEY: 'k' }, 'writing')).toThrow();
  });

  it('modelForPurpose：同一配置只构建一次 LanguageModel（缓存复用）', () => {
    expect(modelForPurpose(FULL_ENV, 'writing')).toBe(modelForPurpose(FULL_ENV, 'writing'));
  });

  it('.novel 目录与 MCP 命令的默认值及覆盖', () => {
    expect(getNovelDir({})).toBe(path.join(process.cwd(), '.novel'));
    expect(getNovelDir({ NOVEL_DIR: 'D:/data' })).toBe('D:/data');

    const def = getDomainMcpCommand({});
    expect(def.command).toBe('npx');
    expect(def.args.join(' ')).toBe('tsx ../domain/src/server.ts');

    const over = getDomainMcpCommand({ MCP_DOMAIN_CMD: 'node C:/server.js' });
    expect(over.command).toBe('node');
    expect(over.args).toEqual(['C:/server.js']);
  });

  it('MCP 命令支持双引号分段：带空格路径的 command/参数不被拆碎', () => {
    const quotedCmd = getDomainMcpCommand({ MCP_DOMAIN_CMD: '"C:\\Program Files\\node.exe" script.js' });
    expect(quotedCmd.command).toBe('C:\\Program Files\\node.exe');
    expect(quotedCmd.args).toEqual(['script.js']);

    const quotedArg = getDomainMcpCommand({ MCP_DOMAIN_CMD: 'node "C:/my tools/server.js" --flag "a b"' });
    expect(quotedArg.command).toBe('node');
    expect(quotedArg.args).toEqual(['C:/my tools/server.js', '--flag', 'a b']);

    // 连续空白/空引号对不产出多余片段
    const messy = getDomainMcpCommand({ MCP_DOMAIN_CMD: 'node  ""  "x y"   z' });
    expect(messy.args).toEqual(['x y', 'z']);
  });

  it('runtime 文件路径默认落到仓库根，可用 CORE_RUNTIME_FILE 覆盖', () => {
    expect(getRuntimeFilePath({})).toMatch(/core-runtime\.local\.json$/);
    expect(getRuntimeFilePath({ CORE_RUNTIME_FILE: 'C:/tmp/r.json' })).toBe('C:/tmp/r.json');
  });

  it('Node 版本门禁：主版本低于下限拒启，达到或超过放行', () => {
    expect(() => assertNodeVersion('23.11.1')).toThrow(/Node 版本过低/);
    expect(() => assertNodeVersion('22.0.0')).toThrow(/Node 版本过低/);
    expect(() => assertNodeVersion('99.0.0')).not.toThrow();
    expect(() => assertNodeVersion(`${MIN_NODE_MAJOR}.1.0`)).not.toThrow();
    // 非法版本串（非数字开头）按不满足处理
    expect(() => assertNodeVersion('v24.1.0')).toThrow();
  });

  it('git commit 自报：仓库内取到短 commit，非 git 目录回退 unknown（不抛错）', () => {
    const commit = getGitCommit();
    // 无 .git 的环境（CI 检出/打包产物）不报错，回退稳定占位 'unknown'
    expect(commit).toMatch(/^(unknown|[0-9a-f]{4,})$/);
    const fallback = getGitCommit(path.join(process.cwd(), '不存在的目录'));
    expect(fallback).toBe('unknown');
  });
});
