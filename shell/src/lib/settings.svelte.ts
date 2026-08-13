/**
 * settings.svelte.ts —— 设置面板（开放项 2 定稿清单）：
 * 审批模式 ask/auto/yolo、主题明/暗、正文字号 15/17/19、打字机滚动、自动保存间隔、
 * 采纳前自动快照（常开不可关）、小改就地分流、采纳留痕。默认值全部最保守。
 * 持久化 localStorage；主题/字号写回 CSS 变量（theme.ts 唯一来源）。
 *
 * 应用级配置（config.json，Tauri app_config_dir 持久化）：作品目录 + LLM 双档模型。
 * 生效优先级 配置 > 环境变量 > 默认；模型/作品目录是 core 启动时读的，保存后需 restart_core 才生效。
 */
import { applyTheme, type ThemeMode } from '../theme.js';
import { tauriInvoke } from './core.js';

export type ApprovalMode = 'ask' | 'auto' | 'yolo';

/** 应用级 LLM 配置（与 Rust AppConfig 的 llm 字段对应；空串=回落环境变量）。 */
export interface AppLlmShape {
  baseUrl: string;
  apiKey: string;
  model: string;
  modelCheap: string;
}

/** 应用级配置（config.json）：workDir 空串=默认目录。 */
export interface AppConfigShape {
  workDir: string;
  llm: AppLlmShape;
}

/** 单字段当前生效值与来源（config/env/default），占位符展示用。 */
export interface ResolvedField {
  value: string;
  source: 'config' | 'env' | 'default';
}

/** config_status 返回值：已存配置 + 各字段生效值/来源（apiKey 已打码）。 */
export interface ConfigStatus {
  config: AppConfigShape;
  workDir: ResolvedField;
  baseUrl: ResolvedField;
  apiKey: ResolvedField;
  model: ResolvedField;
  modelCheap: ResolvedField;
}

export interface SettingsShape {
  approvalMode: ApprovalMode;
  mode: ThemeMode;
  fontSize: 15 | 17 | 19;
  typewriter: boolean;
  autosaveSec: 30 | 60 | 120;
  /** 采纳/危险操作前自动快照：建议不允许关，仅列出以示存在（B4 不受审批模式影响）。 */
  snapshotBeforeAdopt: boolean;
  /** 小改就地浮层 / 大改进暂存的分流（B1）：关则全部进暂存。 */
  inlineSplit: boolean;
  /** 采纳留痕：显示"为何采纳"（B8）。 */
  showInstruction: boolean;
}

const DEFAULTS: SettingsShape = {
  approvalMode: 'ask',
  mode: 'light',
  fontSize: 17,
  typewriter: true,
  autosaveSec: 60,
  snapshotBeforeAdopt: true,
  inlineSplit: true,
  showInstruction: true,
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

class SettingsStore {
  approvalMode = $state<ApprovalMode>(DEFAULTS.approvalMode);
  mode = $state<ThemeMode>(DEFAULTS.mode);
  fontSize = $state<15 | 17 | 19>(DEFAULTS.fontSize);
  typewriter = $state(DEFAULTS.typewriter);
  autosaveSec = $state<30 | 60 | 120>(DEFAULTS.autosaveSec);
  snapshotBeforeAdopt = $state(DEFAULTS.snapshotBeforeAdopt);
  inlineSplit = $state(DEFAULTS.inlineSplit);
  showInstruction = $state(DEFAULTS.showInstruction);

  // ---- 应用级配置（config.json：作品目录 + LLM 双档；配置值 > 环境变量 > 默认） ----
  /** 配置里的作品目录（空串=默认）。 */
  appWorkDir = $state('');
  appBaseUrl = $state('');
  appApiKey = $state('');
  appModel = $state('');
  appModelCheap = $state('');
  /** 当前生效值/来源（config/env/default）；null=尚未加载（非 Tauri 环境）。 */
  configStatus = $state<ConfigStatus | null>(null);
  saving = $state(false);
  restarting = $state(false);
  appNotice = $state<string | null>(null);
  appError = $state<string | null>(null);
  /** App 注册的重启后重连回调（connectCore → 各 store re-init）。 */
  private coreRestartHandler: (() => Promise<void> | void) | null = null;

  registerCoreRestartHandler(h: (() => Promise<void> | void) | null): void {
    this.coreRestartHandler = h;
  }

  constructor() {
    // 旧版 ui store 用 'theme' key 记明暗，向后兼容
    const legacy = typeof localStorage !== 'undefined' ? localStorage.getItem('theme') : null;
    this.mode = legacy === 'dark' ? 'dark' : load<ThemeMode>('settings.mode', DEFAULTS.mode);
    this.approvalMode = load<ApprovalMode>('settings.approval', DEFAULTS.approvalMode);
    this.fontSize = load<15 | 17 | 19>('settings.fontSize', DEFAULTS.fontSize);
    this.typewriter = load<boolean>('settings.typewriter', DEFAULTS.typewriter);
    this.autosaveSec = load<30 | 60 | 120>('settings.autosave', DEFAULTS.autosaveSec);
    this.snapshotBeforeAdopt = DEFAULTS.snapshotBeforeAdopt; // 常开，不落盘
    this.inlineSplit = load<boolean>('settings.inlineSplit', DEFAULTS.inlineSplit);
    this.showInstruction = load<boolean>('settings.showInstruction', DEFAULTS.showInstruction);
    this.applyVisual();
  }

  private persist(): void {
    save('settings.mode', this.mode);
    save('settings.approval', this.approvalMode);
    save('settings.fontSize', this.fontSize);
    save('settings.typewriter', this.typewriter);
    save('settings.autosave', this.autosaveSec);
    save('settings.inlineSplit', this.inlineSplit);
    save('settings.showInstruction', this.showInstruction);
    localStorage.removeItem('theme'); // 旧 key 让位
  }

  /** 主题/字号落 CSS 变量（theme.ts）；非浏览器环境（单测）跳过。 */
  applyVisual(): void {
    if (typeof document === 'undefined') return;
    applyTheme(this.mode, document.documentElement, this.fontSize);
  }

  setMode(mode: ThemeMode): void {
    this.mode = mode;
    this.applyVisual();
    this.persist();
  }

  toggleMode(): void {
    this.setMode(this.mode === 'light' ? 'dark' : 'light');
  }

  setFontSize(n: 15 | 17 | 19): void {
    this.fontSize = n;
    this.applyVisual();
    this.persist();
  }

  setApproval(mode: ApprovalMode): void {
    this.approvalMode = mode;
    this.persist();
  }

  setTypewriter(on: boolean): void {
    this.typewriter = on;
    this.persist();
  }

  setAutosave(sec: 30 | 60 | 120): void {
    this.autosaveSec = sec;
    this.persist();
  }

  setInlineSplit(on: boolean): void {
    this.inlineSplit = on;
    this.persist();
  }

  setShowInstruction(on: boolean): void {
    this.showInstruction = on;
    this.persist();
  }

  // ---------- 应用级配置（config.json，Tauri 侧持久化） ----------

  /** 启动时加载：拉 config_status（已存配置 + 各字段生效值/来源）。非 Tauri 环境静默跳过。 */
  async loadAppConfig(): Promise<void> {
    const invoke = tauriInvoke();
    if (!invoke) return;
    try {
      const s = await invoke<ConfigStatus>('config_status');
      this.configStatus = s;
      this.appWorkDir = s.config.workDir ?? '';
      this.appBaseUrl = s.config.llm?.baseUrl ?? '';
      this.appApiKey = s.config.llm?.apiKey ?? '';
      this.appModel = s.config.llm?.model ?? '';
      this.appModelCheap = s.config.llm?.modelCheap ?? '';
      this.appError = null;
    } catch (err) {
      this.appError = `读取配置失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** 保存应用级配置（作品目录 + LLM 四字段，明文存本机 config.json）；保存后需重启 core 生效。 */
  async saveAppConfig(): Promise<boolean> {
    const invoke = tauriInvoke();
    if (!invoke) {
      this.appError = '应用配置仅 Tauri 环境支持';
      return false;
    }
    this.saving = true;
    this.appError = null;
    try {
      await invoke('write_config', {
        config: {
          workDir: this.appWorkDir,
          llm: {
            baseUrl: this.appBaseUrl,
            apiKey: this.appApiKey,
            model: this.appModel,
            modelCheap: this.appModelCheap,
          },
        },
      });
      this.appNotice = '已保存到本机应用数据目录（config.json）；重启 core 后生效';
      await this.loadAppConfig();
      return true;
    } catch (err) {
      this.appError = `保存配置失败：${err instanceof Error ? err.message : String(err)}`;
      return false;
    } finally {
      this.saving = false;
    }
  }

  /** 重启 core：杀旧进程按最新配置重拉（模型/作品目录是 core 启动时读的）；成功后跑 App 注册的重连回调。 */
  async restartCore(): Promise<boolean> {
    const invoke = tauriInvoke();
    if (!invoke) {
      this.appError = '重启 core 仅 Tauri 环境支持';
      return false;
    }
    this.restarting = true;
    this.appError = null;
    try {
      await invoke('restart_core');
      this.appNotice = 'core 已按新配置重启，正在重连…';
      if (this.coreRestartHandler) await this.coreRestartHandler();
      return true;
    } catch (err) {
      this.appError = `重启 core 失败：${err instanceof Error ? err.message : String(err)}`;
      return false;
    } finally {
      this.restarting = false;
    }
  }

  dismissAppNotice(): void {
    this.appNotice = null;
  }
  dismissAppError(): void {
    this.appError = null;
  }
}

export const settings = new SettingsStore();
