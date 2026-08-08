// 测试：环境配置——缺失抛错、双档模型映射、默认/覆盖取值。
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createModelForTier, getDomainMcpCommand, getNovelDir, getRuntimeFilePath, loadLlmConfig } from '../src/config.js';

const FULL_ENV = { LLM_BASE_URL: 'http://127.0.0.1:11434/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm1', LLM_MODEL_CHEAP: 'm2' };

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

  it('双档模型映射：writing 用 LLM_MODEL，background 用 LLM_MODEL_CHEAP', () => {
    const config = loadLlmConfig(FULL_ENV);
    const modelId = (model: { modelId: string }): string => model.modelId;
    expect(modelId(createModelForTier(config, 'writing') as { modelId: string })).toBe('m1');
    expect(modelId(createModelForTier(config, 'background') as { modelId: string })).toBe('m2');
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

  it('runtime 文件路径默认落到仓库根，可用 CORE_RUNTIME_FILE 覆盖', () => {
    expect(getRuntimeFilePath({})).toMatch(/core-runtime\.local\.json$/);
    expect(getRuntimeFilePath({ CORE_RUNTIME_FILE: 'C:/tmp/r.json' })).toBe('C:/tmp/r.json');
  });
});
