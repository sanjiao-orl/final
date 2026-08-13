// settings.svelte.ts 应用级配置单测：loadAppConfig / saveAppConfig / restartCore（mock tauri invoke，
// 参照现有 *.svelte.test.ts 的写法）。localStorage 偏好项不在本文件覆盖范围（原逻辑不动）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from './settings.svelte.js';

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => unknown;

/** 挂上 window.__TAURI_INTERNALS__.invoke mock；返回该 mock 以便断言调用。 */
function mockTauri(impl: InvokeFn): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke: fn } },
  });
  return fn;
}

/** config_status 样例：配置全空，生效值来自环境变量/缺省。 */
const STATUS = {
  config: { workDir: '', llm: { baseUrl: '', apiKey: '', model: '', modelCheap: '' } },
  workDir: { value: 'C:/works/demo', source: 'default' },
  baseUrl: { value: 'https://opencode.ai/zen/go/v1', source: 'env' },
  apiKey: { value: 'sk-a••••', source: 'env' },
  model: { value: 'kimi-k2.6', source: 'env' },
  modelCheap: { value: 'deepseek-v4-flash', source: 'env' },
};

beforeEach(() => {
  settings.appWorkDir = '';
  settings.appBaseUrl = '';
  settings.appApiKey = '';
  settings.appModel = '';
  settings.appModelCheap = '';
  settings.configStatus = null;
  settings.appNotice = null;
  settings.appError = null;
  settings.registerCoreRestartHandler(null);
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('应用级配置（config.json）', () => {
  it('loadAppConfig：config_status 结果进 store（已存配置 + 生效值/来源）', async () => {
    const invoke = mockTauri(async (cmd) => {
      if (cmd === 'config_status') return STATUS;
      throw new Error(`unexpected ${cmd}`);
    });
    await settings.loadAppConfig();
    expect(invoke).toHaveBeenCalledWith('config_status');
    expect(settings.configStatus).toEqual(STATUS);
    expect(settings.appWorkDir).toBe('');
    expect(settings.appBaseUrl).toBe('');
    expect(settings.appModel).toBe('');
  });

  it('saveAppConfig：write_config 带 camelCase 配置，成功后刷新 config_status 并给提示', async () => {
    settings.appWorkDir = 'C:/works/新书';
    settings.appBaseUrl = 'https://llm.example/v1';
    settings.appApiKey = 'sk-test';
    settings.appModel = 'm1';
    settings.appModelCheap = 'm2';
    const invoke = mockTauri(async (cmd) => {
      if (cmd === 'write_config') return undefined;
      if (cmd === 'config_status') return STATUS;
      throw new Error(`unexpected ${cmd}`);
    });
    const ok = await settings.saveAppConfig();
    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('write_config', {
      config: {
        workDir: 'C:/works/新书',
        llm: { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test', model: 'm1', modelCheap: 'm2' },
      },
    });
    expect(settings.appNotice).toContain('已保存');
    expect(settings.configStatus).toEqual(STATUS); // 保存后回读刷新
  });

  it('saveAppConfig 失败：appError 红条，返回 false', async () => {
    mockTauri(async () => {
      throw new Error('磁盘写失败');
    });
    const ok = await settings.saveAppConfig();
    expect(ok).toBe(false);
    expect(settings.appError).toContain('保存配置失败');
    expect(settings.appError).toContain('磁盘写失败');
  });

  it('restartCore：调 restart_core 并跑注册的重连回调', async () => {
    const handler = vi.fn(async () => undefined);
    settings.registerCoreRestartHandler(handler);
    const invoke = mockTauri(async (cmd) => {
      if (cmd === 'restart_core') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    const ok = await settings.restartCore();
    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('restart_core');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(settings.appNotice).toContain('已按新配置重启');
  });

  it('restartCore 失败：appError 红条且不跑重连回调', async () => {
    const handler = vi.fn();
    settings.registerCoreRestartHandler(handler);
    mockTauri(async () => {
      throw new Error('core 起不来');
    });
    const ok = await settings.restartCore();
    expect(ok).toBe(false);
    expect(settings.appError).toContain('重启 core 失败');
    expect(handler).not.toHaveBeenCalled();
  });

  it('非 Tauri 环境：loadAppConfig 静默跳过，save/restart 明确报错', async () => {
    await settings.loadAppConfig(); // 无 window.__TAURI_INTERNALS__（afterEach 已删）
    expect(settings.configStatus).toBeNull();
    expect(await settings.saveAppConfig()).toBe(false);
    expect(settings.appError).toContain('仅 Tauri 环境');
    settings.dismissAppError();
    expect(settings.appError).toBeNull();
    expect(await settings.restartCore()).toBe(false);
    expect(settings.appError).toContain('仅 Tauri 环境');
  });
});
