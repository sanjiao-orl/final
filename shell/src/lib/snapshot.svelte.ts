/**
 * snapshot.ts —— B4 采纳前自动快照 + 一键还原（壳私有，基于 .novel/history/）。
 * 快照本身由 domain 的 write_chapter 安全阀在每次覆写前自动滚动（SNAPSHOT_KEEP=20 份），
 * 壳只做：列出该章最新快照、一键还原（读快照 → write_chapter 写回 → 刷新现场）、采纳 toast。
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
}

export const snapshot = new SnapshotStore();
