/**
 * settings.svelte.ts —— 设置面板（开放项 2 定稿清单）：
 * 审批模式 ask/auto/yolo、主题明/暗、正文字号 15/17/19、打字机滚动、自动保存间隔、
 * 采纳前自动快照（常开不可关）、小改就地分流、采纳留痕。默认值全部最保守。
 * 持久化 localStorage；主题/字号写回 CSS 变量（theme.ts 唯一来源）。
 *
 * 应用级配置（config.json，Tauri app_config_dir 持久化）：作品目录 + 作品注册表 + LLM 双档模型。
 * 生效优先级 配置 > 环境变量 > 默认；模型/作品目录是 core 启动时读的，保存后需 restart_core 才生效。
 */
import { applyTheme, type ThemeMode } from '../theme.js';
import { tauriInvoke, type CoreClient, type LlmStatus } from './core.js';

export type ApprovalMode = 'ask' | 'auto' | 'yolo';

/** 与 core/rust normalizePresetId 同口径：环境变量预设 id 统一为大写下划线。 */
export function normalizePresetId(id: string): string {
  return id.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** 单个模型预设（D4）：id 由壳生成并保持稳定；name 仅展示。 */
export interface AppLlmPreset {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 用途→预设 id 分配（D4）：未指定的用途回退第一预设（core 侧规则）。 */
export interface AppLlmAssign {
  writing?: string;
  background?: string;
  review?: string;
}

/** 应用级 LLM 配置（与 Rust AppConfig 的 llm 字段对应；空串=回落环境变量）。 */
export interface AppLlmShape {
  baseUrl: string;
  apiKey: string;
  model: string;
  modelCheap: string;
  presets?: AppLlmPreset[];
  assign?: AppLlmAssign;
}

/** 应用级配置（config.json）：workDir 空串=默认目录；works=作品注册表（绝对路径列表）。 */
export interface AppConfigShape {
  workDir: string;
  works?: string[];
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
  /** 小改就地浮层 / 大改进暂存的分流（B1）：默认关=暂存优先（小改也进暂存区）；开=小改就地浮层。 */
  inlineSplit: boolean;
  /** 采纳留痕：显示"为何采纳"（B8）。 */
  showInstruction: boolean;
  /** 触发式续写：结果只进暂存区候选，默认关闭。 */
  continueEnabled: boolean;
  /** 钉住 AI 面板：正文点击不再收起，默认关闭。 */
  aiPinned: boolean;
}

const DEFAULTS: SettingsShape = {
  approvalMode: 'ask',
  mode: 'light',
  fontSize: 17,
  typewriter: true,
  autosaveSec: 60,
  snapshotBeforeAdopt: true,
  inlineSplit: false,
  showInstruction: true,
  continueEnabled: false,
  aiPinned: false,
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
  continueEnabled = $state(DEFAULTS.continueEnabled);
  aiPinned = $state(DEFAULTS.aiPinned);

  // ---- 应用级配置（config.json：作品目录 + LLM 双档；配置值 > 环境变量 > 默认） ----
  /** 配置里的作品目录（空串=默认）。 */
  appWorkDir = $state('');
  /** 作品注册表：作品目录绝对路径列表（去重）。 */
  appWorks = $state<string[]>([]);
  appBaseUrl = $state('');
  appApiKey = $state('');
  appModel = $state('');
  appModelCheap = $state('');
  /** 模型预设列表（D4）：非空时优先走预设分配，旧四字段仅作无预设时的兼容回退。 */
  appLlmPresets = $state<AppLlmPreset[]>([]);
  /** 用途→预设 id 分配（D4）。 */
  appLlmAssign = $state<AppLlmAssign>({});
  /** 当前生效值/来源（config/env/default）；null=尚未加载（非 Tauri 环境）。 */
  configStatus = $state<ConfigStatus | null>(null);
  /** core 回报的模型真值；null=尚未加载。 */
  llmStatus = $state<LlmStatus | null>(null);
  private coreClient: CoreClient | null = null;
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
    this.continueEnabled = load<boolean>('settings.continueEnabled', DEFAULTS.continueEnabled);
    this.aiPinned = load<boolean>('settings.aiPinned', DEFAULTS.aiPinned);
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
    save('settings.continueEnabled', this.continueEnabled);
    save('settings.aiPinned', this.aiPinned);
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

  setContinueEnabled(on: boolean): void {
    this.continueEnabled = on;
    this.persist();
  }

  setAiPinned(on: boolean): void {
    this.aiPinned = on;
    this.persist();
  }

  // ---------- 模型预设（D4：多预设 + 按用途分配） ----------

  /** 生成短随机字母数字后缀（nanoid 风格，本地够用）。 */
  private randomSuffix(): string {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  /** 新预设 id：slug 化 name（大写、非字母数字→-），空名/全符号回落 PRESET，再拼随机后缀防撞。 */
  presetIdFrom(name: string): string {
    const slug = name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20);
    return `${slug || 'PRESET'}-${this.randomSuffix()}`;
  }

  /** 添加一个空预设并返回其 id。 */
  addLlmPreset(name = ''): string {
    const id = this.presetIdFrom(name);
    this.appLlmPresets.push({ id, name, baseUrl: '', apiKey: '', model: '' });
    return id;
  }

  /** 删除预设；引用它的用途分配一并清掉，避免指向悬空 id。 */
  removeLlmPreset(id: string): void {
    this.appLlmPresets = this.appLlmPresets.filter((p) => p.id !== id);
    for (const purpose of ['writing', 'background', 'review'] as const) {
      if (this.appLlmAssign[purpose] === id) delete this.appLlmAssign[purpose];
    }
  }

  /** 设置用途→预设 id；undefined 清空该用途分配（回退第一预设）。 */
  setLlmAssign(purpose: keyof AppLlmAssign, presetId: string | undefined): void {
    if (presetId) this.appLlmAssign[purpose] = presetId;
    else delete this.appLlmAssign[purpose];
  }

  /**
   * 用途分配下拉可选项：配置预设 ∪ llmStatus.presets 中未被配置预设覆盖的项
   * （归一化后同 id 去重，与组件只读卡片的过滤口径一致）。环境变量来源的项标注来源。
   */
  get assignablePresets(): Array<{ id: string; label: string; fromEnv: boolean }> {
    const out: Array<{ id: string; label: string; fromEnv: boolean }> = [];
    const seen = new Set<string>();
    for (const p of this.appLlmPresets) {
      const nid = normalizePresetId(p.id);
      if (!nid || seen.has(nid)) continue;
      seen.add(nid);
      out.push({ id: p.id, label: p.name.trim() || p.id, fromEnv: false });
    }
    for (const p of this.llmStatus?.presets ?? []) {
      const nid = normalizePresetId(p.id);
      if (!nid || seen.has(nid)) continue;
      seen.add(nid);
      out.push({ id: p.id, label: `${p.id}（环境变量）`, fromEnv: true });
    }
    return out;
  }

  // ---------- 应用级配置（config.json，Tauri 侧持久化） ----------

  init(client: CoreClient): void {
    this.coreClient = client;
  }

  async loadLlmStatus(): Promise<void> {
    if (!this.coreClient) return;
    try {
      this.llmStatus = await this.coreClient.getLlm();
    } catch (err) {
      this.appError = `读取 core 模型状态失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** 启动时加载：拉 config_status（已存配置 + 各字段生效值/来源）。非 Tauri 环境静默跳过。 */
  async loadAppConfig(): Promise<void> {
    const invoke = tauriInvoke();
    if (!invoke) return;
    try {
      const s = await invoke<ConfigStatus>('config_status');
      this.configStatus = s;
      this.appWorkDir = s.config.workDir ?? '';
      this.appWorks = s.config.works ?? [];
      // 老配置没有 works 字段：把当前生效作品目录补进列表（下次保存配置时落库，自愈注册）。
      const currentDir = s.workDir?.value ?? '';
      if (currentDir && !this.appWorks.includes(currentDir)) {
        this.appWorks = [currentDir, ...this.appWorks];
      }
      this.appBaseUrl = s.config.llm?.baseUrl ?? '';
      this.appApiKey = s.config.llm?.apiKey ?? '';
      this.appModel = s.config.llm?.model ?? '';
      this.appModelCheap = s.config.llm?.modelCheap ?? '';
      this.appLlmPresets = s.config.llm?.presets ?? [];
      this.appLlmAssign = s.config.llm?.assign ?? {};
      this.appError = null;
    } catch (err) {
      this.appError = `读取配置失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** 保存应用级配置（作品目录 + 作品注册表 + LLM 预设/回退字段，明文存本机 config.json）；保存后需重启 core 生效。 */
  async saveAppConfig(): Promise<boolean> {
    const invoke = tauriInvoke();
    if (!invoke) {
      this.appError = '应用配置仅 Tauri 环境支持';
      return false;
    }
    // 保存前校验：预设 id 非空唯一、四个输入非空；assign 只能指向已存在的预设 id。
    const ids = new Set<string>();
    for (const p of this.appLlmPresets) {
      if (!p.id.trim()) {
        this.appError = '模型预设 id 不能为空';
        return false;
      }
      if (ids.has(p.id)) {
        this.appError = `模型预设 id 重复：${p.id}`;
        return false;
      }
      ids.add(p.id);
      if (!p.name.trim() || !p.baseUrl.trim() || !p.apiKey.trim() || !p.model.trim()) {
        this.appError = `预设「${p.name.trim() || p.id}」存在空字段：名称/Base URL/API Key/模型 均必填`;
        return false;
      }
    }
    const purposeNames: Record<keyof AppLlmAssign, string> = {
      writing: '写作档',
      background: '后台档',
      review: '审阅档',
    };
    for (const purpose of ['writing', 'background', 'review'] as const) {
      const pid = this.appLlmAssign[purpose];
      // assign 可指向 配置预设 ∪ llmStatus.presets（各自归一化后比对）：环境变量预设虽不在
      // config.json，经 Tauri 注入后 core 一样能解析。llmStatus 未加载时保持原口径（只认配置预设）。
      const allowed = new Set<string>([...ids].map((id) => normalizePresetId(id)));
      for (const p of this.llmStatus?.presets ?? []) allowed.add(normalizePresetId(p.id));
      if (pid && !allowed.has(normalizePresetId(pid))) {
        this.appError = `${purposeNames[purpose]}指向不存在的预设：${pid}`;
        return false;
      }
    }

    this.saving = true;
    this.appError = null;
    try {
      await invoke('write_config', {
        config: {
          workDir: this.appWorkDir,
          works: this.appWorks,
          llm: {
            baseUrl: this.appBaseUrl,
            apiKey: this.appApiKey,
            model: this.appModel,
            modelCheap: this.appModelCheap,
            presets: this.appLlmPresets,
            assign: this.appLlmAssign,
          },
        },
      });
      await this.loadAppConfig();
      // 正常运行时 coreClient 已由 App 注入；无 client 仅为非 boot 单测/早期调用保留保存语义。
      if (this.coreClient) {
        if (!(await this.restartCore())) return false;
        await this.loadLlmStatus();
      }
      const effective = this.llmStatus?.effective;
      const model = (p: 'writing' | 'background' | 'review') => effective?.[p]?.error ?? effective?.[p]?.model ?? '未配置';
      this.appNotice = `已保存并重启生效:写作档=${model('writing')} / 背景档=${model('background')} / 审阅档=${model('review')}`;
      return true;
    } catch (err) {
      this.appError = `保存配置失败：${err instanceof Error ? err.message : String(err)}`;
      return false;
    } finally {
      this.saving = false;
    }
  }

  /** 切换作品：写 workDir + 注册进 works 去重 → 保存配置 → 重启 core（重连回调重载全部数据）。 */
  async switchWork(dir: string): Promise<boolean> {
    const invoke = tauriInvoke();
    if (!invoke) {
      this.appError = '切换作品仅 Tauri 环境支持';
      return false;
    }
    this.appWorkDir = dir;
    this.appWorks = [...new Set([...this.appWorks, dir])];
    const saved = await this.saveAppConfig();
    if (!saved) {
      this.appError = `切换作品失败：${this.appError ?? '保存配置失败'}`;
      return false;
    }
    if (!this.coreClient) return (await this.restartCore());
    return true;
  }

  /** 新建作品：Tauri 侧建 <parentDir>/<name>/manuscript，成功后注册并切换过去。 */
  async createWork(parentDir: string, name: string): Promise<boolean> {
    const invoke = tauriInvoke();
    if (!invoke) {
      this.appError = '新建作品仅 Tauri 环境支持';
      return false;
    }
    try {
      const dir = await invoke<string>('create_work', { parentDir, name });
      return await this.switchWork(dir);
    } catch (err) {
      this.appError = `新建作品失败：${err instanceof Error ? err.message : String(err)}`;
      return false;
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
