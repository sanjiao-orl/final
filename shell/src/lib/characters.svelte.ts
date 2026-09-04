/**
 * characters.svelte.ts —— 角色卡面板壳侧状态（4.3 角色卡批）：列表/左栏第四 tab/触发角色补账扫描。
 * 数据经 core MCP 工具（character_list）与 /v1/scan/character；裁决纪律（超域疑似去留、别名登记）
 * 在 domain 收件箱，壳只搬运。失败接 work.error 红条（不伪装空态，4.2.1 同款纪律）。
 */
import type { CoreClient } from './core.js';
import { work } from './work.svelte.js';

export interface CharacterStateVM {
  field: string;
  value: string;
  since: string;
  line?: number;
  quote?: string;
}

export interface CharacterVM {
  name: string;
  aliases?: string[] | undefined;
  kind?: 'character' | 'faction' | 'location' | 'lore' | undefined;
  role?: string | undefined;
  faction?: string | undefined;
  description?: string | undefined;
  relations?: string | undefined;
  states?: CharacterStateVM[] | undefined;
}

export class CharactersStore {
  entries = $state<CharacterVM[]>([]);
  /** 左栏「角色」tab 是否打开（与 目录/暂存/收件箱 互斥）。 */
  tabOpen = $state(false);
  scanning = $state(false);
  /** 最近一次角色补账扫描读数。 */
  lastScan = $state<{ unknownCandidates: number; variantSuspects: number; added: number; skipped: number } | null>(null);
  count = $derived(this.entries.length);

  private client!: CoreClient;

  init(client: CoreClient): void {
    this.client = client;
  }

  openTab(): void {
    this.tabOpen = true;
    void this.load(); // 每次打开都刷新（换书/重启不留残留，与收件箱同纪律）
  }

  async load(): Promise<void> {
    if (!this.client || !work.workDir) return;
    try {
      const r = await this.client.callTool<{ count: number; characters: CharacterVM[] }>('character_list', { workDir: work.workDir });
      this.entries = r.characters;
    } catch (err) {
      work.error = `角色卡加载失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** 触发角色维确定性补账（零 LLM：超域疑似/写法变体提案入收件箱，作者裁决）。 */
  async scan(maxCandidates?: number): Promise<void> {
    if (this.scanning || !this.client || !work.workDir) return;
    this.scanning = true;
    try {
      const r = await this.client.scanCharacters(work.workDir, maxCandidates);
      this.lastScan = { unknownCandidates: r.unknownCandidates, variantSuspects: r.variantSuspects, added: r.inbox.added.length, skipped: r.inbox.skipped.length };
      await this.load();
    } catch (err) {
      work.error = `角色补账扫描失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.scanning = false;
    }
  }
}

export const characters = new CharactersStore();
