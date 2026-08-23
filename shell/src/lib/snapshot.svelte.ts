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
/** 知情维事实项（批三-2 结构深化）：since=得知章 relPath（时间轴），refs=回指伏笔 id。domain normalize 后恒为对象。 */
export interface KnowledgeFactView {
  fact: string;
  since?: string;
  refs?: string[];
  /** 原文摘录锚（决策 0013，跳转定位用）。 */
  quote?: string;
}
export interface LedgerView {
  clock: Array<{ chapters: string[]; thread?: string; storyDay?: string; season?: string; absoluteDate?: string; notes?: string }>;
  props: Array<{ name: string; type?: string; holder?: string; status?: string; custody: Array<{ chapter: string; holder?: string; note?: string; line?: number; quote?: string }>; tripwire?: string }>;
  promises: Array<{ id: string; name: string; arc: string; heat?: string; setups: Array<{ chapter: string; line?: number; quote?: string }>; payoffs: Array<{ chapter: string; line?: number; quote?: string }>; due?: number; note?: string; expectedVolume?: string; links?: { props?: string[]; characters?: string[] } }>;
  knowledge: Array<{ character: string; knows: KnowledgeFactView[]; doesNotKnow?: KnowledgeFactView[]; visibility?: string; knownBy?: string[] }>;
  doNotReexplain: string[];
  protect: Array<{ item: string; reason?: string }>;
  tripwires: string[];
}

/** ledger_chapter_slice 工具返回（契约为准，domain 并行开发）：found=false 时 ledger 为空结构。 */
export interface LedgerSliceResult {
  workDir: string;
  chapterRelPath: string;
  found: boolean;
  chapterTitle: string | null;
  ledger: LedgerView;
  slice: string;
}

/** 上下文栏渲染现场（单口径：组件渲染与 chat 联动刷新读写同一处）。 */
export interface LedgerPanelState {
  ledger: LedgerView;
  /** 数据来源路径（切片=章 relPath，全书=.novel/ledger.md）。 */
  dataPath: string;
  /** 切片命中时的章名；全书口径为 null。 */
  chapterTitle: string | null;
}

function hms(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

export class SnapshotStore {
  toast = $state<SnapshotToast | null>(null);
  busy = $state(false);
  /** 上下文栏口径：随章切片 / 全书。会话内状态，不落 localStorage。 */
  ledgerMode = $state<'chapter' | 'all'>('chapter');
  /** 上下文栏渲染现场（单口径：ContextColumn 渲染与 chat 联动刷新都读写这里）。 */
  ledgerPanel = $state<LedgerPanelState | null>(null);
  /** 最近一次刷新时间戳（HH:MM:SS）。 */
  ledgerAt = $state<string | null>(null);
  ledgerLoading = $state(false);
  ledgerError = $state<string | null>(null);
  /** 轻提示（采纳后诊断提醒等，无还原动作，复用 toast 展示机制）。 */
  notice = $state<{ message: string } | null>(null);

  private client!: CoreClient;
  private workDir = '';
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

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

  /** 读本章账本切片（四维过滤视图，随章口径）；found=false 时 ledger 为空结构。 */
  async loadChapterSlice(chapterRelPath: string): Promise<LedgerSliceResult> {
    return this.client.callTool<LedgerSliceResult>('ledger_chapter_slice', {
      workDir: this.workDir,
      chapterRelPath,
    });
  }

  /**
   * 按当前口径重拉上下文栏（ContextColumn 唯一取数入口，chat 的 ledger_upsert 联动也走这里）：
   * 随章且有当前章 → ledger_chapter_slice（found=false 回退全书）；全书/无当前章 → ledger_read。
   * 结果落 ledgerPanel，组件以它为唯一渲染源；刷新失败写 ledgerError 不外抛（组件展示区分）。
   */
  async refreshLedger(): Promise<void> {
    this.ledgerLoading = true;
    this.ledgerError = null;
    try {
      const cur = this.ledgerMode === 'chapter' ? work.current : null;
      if (cur) {
        const slice = await this.loadChapterSlice(cur.relPath);
        if (slice.found && slice.ledger) {
          this.ledgerPanel = { ledger: slice.ledger, dataPath: cur.relPath, chapterTitle: slice.chapterTitle };
          this.ledgerAt = hms(new Date());
          return;
        }
        // found=false（章不在账本/尚无切片）→ 回退全书
      }
      const r = await this.loadLedger();
      this.ledgerPanel = { ledger: r.ledger, dataPath: r.path, chapterTitle: null };
      this.ledgerAt = hms(new Date());
    } catch (err) {
      this.ledgerError = err instanceof Error ? err.message : String(err);
    } finally {
      this.ledgerLoading = false;
    }
  }

  /** 轻提示（无还原动作）：采纳后诊断提醒等；复用 SnapshotToast 展示机制，自动消隐。 */
  showNotice(message: string): void {
    this.notice = { message };
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
    }, 6000);
  }

  dismissNotice(): void {
    clearTimeout(this.noticeTimer);
    this.notice = null;
  }
}

export const snapshot = new SnapshotStore();
