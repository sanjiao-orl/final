/**
 * snapshot.ts —— B4 采纳前自动快照 + 一键还原（壳私有，基于 .novel/history/）。
 * 快照本身由 domain 的 write_chapter 安全阀在每次覆写前自动滚动（SNAPSHOT_KEEP=20 份），
 * 壳只做：列出该章最新快照、一键还原（读快照 → write_chapter 写回 → 刷新现场）、采纳 toast。
 * 同时兼作「.novel/ 内部文件读取」网关：账本（ContextColumn）也走这里拿 core client（避免把 CoreClient
 * 散落到组件层；store init 一次后，所有依赖 .novel/ 文件读写的壳侧公用同一 client）。
 */
import type { CoreClient } from './core.js';
import { work } from './work.svelte.js';

export interface SnapshotInfo {
  path: string;
  timestamp: string;
}

export interface SnapshotToast {
  message: string;
  /** 发生快照的章 relPath（还原目标）。 */
  relPath: string;
  /** 快照时间（列表里最新一条的文件名时间戳段）。 */
  snapshotTime: string | null;
}

/** ledger_read 工具返回的账本视图（壳只读，只用到四维条目）。 */
export interface LedgerView {
  clock: Array<{ chapters: string[]; thread?: string; storyDay?: string; season?: string; absoluteDate?: string; notes?: string }>;
  props: Array<{ name: string; type?: string; holder?: string; status?: string; custody: Array<{ chapter: string; holder?: string; note?: string }>; tripwire?: string }>;
  promises: Array<{ id: string; name: string; arc: string; heat?: string; setups: Array<{ chapter: string; line?: number; quote?: string }>; payoffs: Array<{ chapter: string; line?: number }>; due?: number; note?: string }>;
  knowledge: Array<{ character: string; knows: string[]; doesNotKnow?: string[]; visibility?: string; knownBy?: string[] }>;
  doNotReexplain: string[];
  protect: Array<{ item: string; reason?: string }>;
  tripwires: string[];
}

export class SnapshotStore {
  toast = $state<SnapshotToast | null>(null);
  busy = $state(false);

  private client!: CoreClient;
  private workDir = '';
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  init(client: CoreClient, workDir: string): void {
    this.client = client;
    this.workDir = workDir;
  }

  /** 某章的快照列表（新在前）。 */
  async listForChapter(relPath: string): Promise<SnapshotInfo[]> {
    try {
      const r = await this.client.callTool<{ snapshots: SnapshotInfo[] }>('list_snapshots', {
        workDir: this.workDir,
        relPath,
      });
      return r.snapshots ?? [];
    } catch {
      return [];
    }
  }

  /** 最新快照时间（文件名时间戳段），无快照返回 null。 */
  async latestTime(relPath: string): Promise<string | null> {
    const list = await this.listForChapter(relPath);
    const name = list[0]?.path.split('/').pop();
    return name ? (name.replace(/\.md$/, '').split('-').slice(0, 2).join('-') ?? name) : null;
  }

  /** 采纳/危险操作后的 toast：提示已写入 + 快照时间 + 一键还原（4.5s 自动消隐）。 */
  async showAdoptedToast(message: string, relPath: string): Promise<void> {
    const snapshotTime = await this.latestTime(relPath);
    this.toast = { message, relPath, snapshotTime };
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast = null;
    }, 4500);
  }

  dismissToast(): void {
    clearTimeout(this.toastTimer);
    this.toast = null;
  }

  /** 一键还原：读最新快照 → write_chapter 写回（写回会再快照一次，安全）→ 刷新现场。 */
  async restoreLatest(relPath: string): Promise<boolean> {
    const list = await this.listForChapter(relPath);
    const snap = list[0];
    if (!snap) {
      work.error = `没有可还原的快照：${relPath}`;
      return false;
    }
    return this.restore(relPath, snap.path);
  }

  /** 还原指定快照：read_snapshot → write_chapter → 若当前正开该章则重载现场 → 刷结构树。 */
  async restore(relPath: string, snapshotPath: string): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const r = await this.client.callTool<{ ok: boolean; content: string }>('read_snapshot', {
        workDir: this.workDir,
        snapshotPath,
      });
      await this.client.callTool('write_chapter', {
        workDir: this.workDir,
        relPath,
        content: r.content,
      });
      // 若当前正开该章：以磁盘为准重载现场（跳过脏保存，避免旧编辑器内容写回覆盖还原结果）
      if (work.current?.relPath === relPath) {
        await work.reloadCurrent();
      }
      await work.loadStructure();
      work.notice = `已还原 ${relPath}（快照 ${snapshotPath.split('/').pop()}）`;
      this.dismissToast();
      return true;
    } catch (err) {
      work.error = `还原失败：${err instanceof Error ? err.message : String(err)}`;
      return false;
    } finally {
      this.busy = false;
    }
  }

  /**
   * 预览快照原文（只读）：read_snapshot 取回 .novel/history/ 下的快照 md 全文，供快照浏览器下半区展示。
   * 不要拿它直接写回 write_chapter，那路径走上面的 restore()。失败返空串。
   */
  async preview(snapshotPath: string): Promise<string> {
    try {
      const r = await this.client.callTool<{ ok: boolean; content: string }>('read_snapshot', {
        workDir: this.workDir,
        snapshotPath,
      });
      return r.content ?? '';
    } catch {
      return '';
    }
  }

  /**
   * 读取作品账本（.novel/ledger.md）：返回四维 + 三张登记表的视图；文件不存在返回空账本视图，解析损坏抛错（透传）。
   * 挂账本失败一次，组件展示已通过状态区分，无需吞错。
   */
  async loadLedger(): Promise<{ ledger: LedgerView; path: string }> {
    const r = await this.client.callTool<{ ledger: LedgerView; path: string }>('ledger_read', {
      workDir: this.workDir,
    });
    return r;
  }
}

export const snapshot = new SnapshotStore();
