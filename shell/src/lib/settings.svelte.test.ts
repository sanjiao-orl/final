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
  config: { workDir: '', works: ['C:/works/demo'], llm: { baseUrl: '', apiKey: '', model: '', modelCheap: '' } },
  workDir: { value: 'C:/works/demo', source: 'default' },
  baseUrl: { value: 'https://opencode.ai/zen/go/v1', source: 'env' },
  apiKey: { value: 'sk-a••••', source: 'env' },
  model: { value: 'kimi-k2.6', source: 'env' },
  modelCheap: { value: 'deepseek-v4-flash', source: 'env' },
};

beforeEach(() => {
  settings.appWorkDir = '';
  settings.appWorks = [];
  settings.appBaseUrl = '';
  settings.appApiKey = '';
  settings.appModel = '';
  settings.appModelCheap = '';
  settings.appLlmPresets = [];
  settings.appLlmAssign = {};
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
    expect(settings.appWorks).toEqual(['C:/works/demo']);
    expect(settings.appBaseUrl).toBe('');
    expect(settings.appModel).toBe('');
  });

  it('loadAppConfig：老配置无 works 时，把当前生效作品目录自愈补进列表', async () => {
    mockTauri(async (cmd) => {
      if (cmd === 'config_status') {
        return { ...STATUS, config: { ...STATUS.config, works: [] } };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    await settings.loadAppConfig();
    expect(settings.appWorks).toEqual(['C:/works/demo']); // 来自 workDir.value 自愈注册
  });

  it('loadAppConfig：预设与 assign 从 config_status 全量带回', async () => {
    const presets = [
      { id: 'MAIN-WRITER-1', name: '主笔', baseUrl: 'https://w.example/v1', apiKey: 'sk-w', model: 'writer-m' },
      { id: 'BG-HELPER-2', name: '后台', baseUrl: 'https://b.example/v1', apiKey: 'sk-b', model: 'bg-m' },
    ];
    const assign = { writing: 'MAIN-WRITER-1', background: 'BG-HELPER-2' };
    mockTauri(async (cmd) => {
      if (cmd === 'config_status') {
        return { ...STATUS, config: { ...STATUS.config, llm: { ...STATUS.config.llm, presets, assign } } };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    await settings.loadAppConfig();
    expect(settings.appLlmPresets).toEqual(presets);
    expect(settings.appLlmAssign).toEqual(assign);
  });

  it('saveAppConfig：预设/assign 全量写进 write_config，不丢字段', async () => {
    settings.appWorkDir = 'C:/works/新书';
    settings.appWorks = ['C:/works/新书'];
    settings.appBaseUrl = 'https://legacy.example/v1';
    settings.appApiKey = 'sk-legacy';
    settings.appModel = 'legacy-m';
    settings.appModelCheap = 'legacy-cheap';
    settings.appLlmPresets = [
      { id: 'MAIN-WRITER-1', name: '主笔', baseUrl: 'https://w.example/v1', apiKey: 'sk-w', model: 'writer-m' },
    ];
    settings.appLlmAssign = { writing: 'MAIN-WRITER-1', review: 'MAIN-WRITER-1' };
    const invoke = mockTauri(async (cmd) => {
      if (cmd === 'write_config') return undefined;
      if (cmd === 'config_status') {
        return {
          ...STATUS,
          config: {
            ...STATUS.config,
            llm: {
              ...STATUS.config.llm,
              presets: settings.appLlmPresets,
              assign: settings.appLlmAssign,
            },
          },
        };
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const ok = await settings.saveAppConfig();
    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('write_config', {
      config: {
        workDir: 'C:/works/新书',
        works: ['C:/works/新书'],
        llm: {
          baseUrl: 'https://legacy.example/v1',
          apiKey: 'sk-legacy',
          model: 'legacy-m',
          modelCheap: 'legacy-cheap',
          presets: settings.appLlmPresets,
          assign: settings.appLlmAssign,
        },
      },
    });
  });

  it('saveAppConfig：预设校验（空字段 / 重复 id / assign 指向不存在）拦截并红条', async () => {
    const invoke = mockTauri(async (cmd) => {
      if (cmd === 'write_config') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    settings.appLlmPresets = [
      { id: 'P1', name: '', baseUrl: 'https://x', apiKey: 'k', model: 'm' },
    ];
    expect(await settings.saveAppConfig()).toBe(false);
    expect(settings.appError).toContain('存在空字段');

    settings.appLlmPresets = [
      { id: 'P1', name: 'a', baseUrl: 'https://x', apiKey: 'k', model: 'm' },
      { id: 'P1', name: 'b', baseUrl: 'https://y', apiKey: 'k', model: 'm' },
    ];
    expect(await settings.saveAppConfig()).toBe(false);
    expect(settings.appError).toContain('重复');

    settings.appLlmPresets = [
      { id: 'P1', name: 'a', baseUrl: 'https://x', apiKey: 'k', model: 'm' },
    ];
    settings.appLlmAssign = { writing: 'NOPE' };
    expect(await settings.saveAppConfig()).toBe(false);
    expect(settings.appError).toContain('指向不存在的预设');
    expect(invoke).not.toHaveBeenCalledWith('write_config', expect.anything());
  });

  it('saveAppConfig：write_config 带 camelCase 配置（含作品注册表），成功后刷新 config_status 并给提示', async () => {
    settings.appWorkDir = 'C:/works/新书';
    settings.appWorks = ['C:/works/新书', 'C:/works/旧书'];
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
        works: ['C:/works/新书', 'C:/works/旧书'],
        llm: {
          baseUrl: 'https://llm.example/v1',
          apiKey: 'sk-test',
          model: 'm1',
          modelCheap: 'm2',
          presets: [],
          assign: {},
        },
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

  it('switchWork：写 config 带 works 去重，成功后调 restart_core', async () => {
    settings.appWorkDir = 'C:/works/a';
    settings.appWorks = ['C:/works/a'];
    settings.appBaseUrl = 'https://llm.example/v1';
    settings.appApiKey = 'sk-test';
    settings.appModel = 'm1';
    settings.appModelCheap = 'm2';
    const invoke = mockTauri(async (cmd) => {
      if (cmd === 'write_config') return undefined;
      if (cmd === 'config_status') {
        return {
          ...STATUS,
          // 切换后生效目录已是新作品（与真实 config_status 一致），自愈逻辑不追加旧目录
          workDir: { value: 'C:/works/b', source: 'config' },
          config: { ...STATUS.config, workDir: 'C:/works/b', works: ['C:/works/a', 'C:/works/b'] },
        };
      }
      if (cmd === 'restart_core') return undefined;
      throw new Error(`unexpected ${cmd}`);
    });
    const ok = await settings.switchWork('C:/works/b');
    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('write_config', {
      config: {
        workDir: 'C:/works/b',
        works: ['C:/works/a', 'C:/works/b'],
        llm: {
          baseUrl: 'https://llm.example/v1',
          apiKey: 'sk-test',
          model: 'm1',
          modelCheap: 'm2',
          presets: [],
          assign: {},
        },
      },
    });
    expect(invoke).toHaveBeenCalledWith('restart_core');
    expect(settings.appWorkDir).toBe('C:/works/b');
    expect(settings.appWorks).toEqual(['C:/works/a', 'C:/works/b']);
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

  it('非 Tauri 环境：loadAppConfig 静默跳过，save/restart/switchWork 明确报错', async () => {
    await settings.loadAppConfig(); // 无 window.__TAURI_INTERNALS__（afterEach 已删）
    expect(settings.configStatus).toBeNull();
    expect(await settings.saveAppConfig()).toBe(false);
    expect(settings.appError).toContain('仅 Tauri 环境');
    settings.dismissAppError();
    expect(settings.appError).toBeNull();
    expect(await settings.restartCore()).toBe(false);
    expect(settings.appError).toContain('仅 Tauri 环境');
    settings.dismissAppError();
    expect(await settings.switchWork('C:/works/b')).toBe(false);
    expect(settings.appError).toContain('仅 Tauri 环境');
  });
});

describe('暂存与裁决 · inlineSplit 默认（反馈#3：默认暂存优先）', () => {
  it('inlineSplit 默认关：小改默认进暂存区（node 环境无 localStorage，走 DEFAULTS）', () => {
    expect(settings.inlineSplit).toBe(false);
  });
});
