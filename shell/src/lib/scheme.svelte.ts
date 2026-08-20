/**
 * scheme.svelte.ts —— 角色与方案（决策 0010）：Toolbar 方案 pill + 三通道请求带 persona。
 * 数据面：GET /v1/posture 拉 personas/schemes/activeScheme；激活/清除走 scheme_set_active 工具。
 * workDir 来自 work store（换书重连后 work.init 先生效，load 即拉到新作品数据）。
 */
import type { CoreClient, PosturePersona, PostureScheme } from './core.js';
import { work } from './work.svelte.js';

export type SchemeChannel = 'chat' | 'rewrite' | 'review';

export class SchemeStore {
  personas = $state<PosturePersona[]>([]);
  schemes = $state<PostureScheme[]>([]);
  activeScheme = $state<string | null>(null);
  /** 拉取中（Toolbar pill 可不响应，避免闪烁）。 */
  loading = $state(false);

  private client!: CoreClient;

  init(client: CoreClient): void {
    this.client = client;
  }

  /** 重拉 posture：有 workDir 才拉（未连接作品不请求，空态落地）；失败置空不抛错（不挡 boot/换书）。 */
  async load(): Promise<void> {
    const dir = work.workDir;
    if (!dir) {
      this.personas = [];
      this.schemes = [];
      this.activeScheme = null;
      return;
    }
    this.loading = true;
    try {
      const r = await this.client.getPosture(dir);
      this.personas = r.personas ?? [];
      this.schemes = r.schemes ?? [];
      this.activeScheme = r.activeScheme ?? null;
    } catch {
      // 方案失败不阻塞主链路：降级为无方案/无激活（pill 显示「方案：默认」）
      this.personas = [];
      this.schemes = [];
      this.activeScheme = null;
    } finally {
      this.loading = false;
    }
  }

  /** 激活方案 / 清除回默认（null 传空串，core 侧已校验方案名）；成功（含清除）后重拉 posture。 */
  async activate(name: string | null): Promise<boolean> {
    try {
      const r = await this.client.callTool<{ ok: boolean; active: string | null }>('scheme_set_active', {
        workDir: work.workDir,
        name: name ?? '',
      });
      if (r && r.ok === false) {
        work.error = '方案激活失败：core 未确认';
        return false;
      }
      await this.load();
      return true;
    } catch (err) {
      work.error = `方案激活失败：${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  /** 三通道 persona：激活方案的 channels 映射；无激活 / 无该通道映射返回 null（请求体不带 persona）。 */
  channelPersona(channel: SchemeChannel): string | null {
    if (!this.activeScheme) return null;
    const scheme = this.schemes.find((s) => s.name === this.activeScheme);
    return scheme?.channels?.[channel] ?? null;
  }
}

export const scheme = new SchemeStore();