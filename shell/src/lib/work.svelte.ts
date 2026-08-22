/**
 * work.svelte.ts —— 作品数据面：结构树、当前章、保存/删除/导出。
 * 壳零产品逻辑的落点：结构/字数/快照/软删/导出全部调 domain 工具（经 core 代理），这里只搬数据。
 */
import type { CoreClient, DailyStats } from './core.js';
import type { ChapterNode, ReadChapterResult, TrashEntry, VolumeNode } from './types.js';
import { setFrontmatterStatus, nextChapterStatus } from './frontmatter.js';
import { writeClipboardText } from './clipboard.js';

/** 编辑器现场入口：序列化 md + 候选替换 / 追加 / 整章替换 / 插入（original 唯一定位）。 */
export interface EditorApi {
  getMd: () => string;
  applyEdit: (original: string, proposed: string) => 'ok' | 'not-found' | 'ambiguous';
  /** kind=append：md 追加到编辑器文档末尾；无编辑器返回 'not-found'。 */
  appendMd: (md: string) => 'ok' | 'not-found';
  /** kind=replace_all：整体替换编辑器正文（md 进 mdToHtml）；无编辑器返回 'not-found'。 */
  replaceBodyMd: (md: string) => 'ok' | 'not-found';
  /** B1 插入其后：proposed 插入 original 之后（原文保留）。 */
  insertAfter?: (original: string, proposed: string) => 'ok' | 'not-found' | 'ambiguous';
}

export interface OpenChapter {
  relPath: string;
  title: string;
  /** 原样保留的 frontmatter 文本块，保存时字节级回拼。 */
  frontmatterRaw: string;
  /** 解析出的 frontmatter（章头元信息行展示用）。 */
  frontmatter: Record<string, unknown>;
  /** 打开时的正文 md（脏检查基准）。 */
  savedMd: string;
  /** frontmatter 目标字数（B5）。 */
  goal?: number;
  /** frontmatter 稳定 id（B7）。 */
  id?: string;
}

export class WorkStore {
  workDir = $state('');
  workName = $derived(this.workDir.split(/[\\/]/).filter(Boolean).pop() ?? '');
  structure = $state<VolumeNode[]>([]);
  current = $state<OpenChapter | null>(null);
  /** 待跳转的场景标题（打开章后由 Editor 消费）。 */
  pendingScene = $state<string | null>(null);
  /** 当前打开的章里被聚焦的场景标题（结构树当前场高亮判定来源）。 */
  currentScene = $state<string | null>(null);
  /** 同章重载计数：App 按 relPath + 该值 keyed Editor，磁盘回写后强制编辑器重挂载。 */
  reloadNonce = $state(0);
  dirty = $state(false);
  saving = $state(false);
  loading = $state(false);
  /** 显式报错（保存/删除/导出失败）：红条展示，不静默。 */
  error = $state<string | null>(null);
  /** 成功提示（导出路径、软删去向等）。 */
  notice = $state<string | null>(null);
  /**
   * 回收站条目（domain list_trash 工具为真相源，TreeView 面板读这里）。
   * 初始空；refreshTrash 拉取，失败静默保留现状（core 旧版无 list_trash 时即恒空列表）。
   */
  trashEntries = $state<TrashEntry[]>([]);

  private client!: CoreClient;
  /** 编辑器现场入口（Editor 挂载时注册，卸载时清空）：序列化 md + 候选文本替换。 */
  private editorApi: EditorApi | null = null;
  /**
   * 旧壳侧 localStorage 回收站残留 key 是否已清理（一次性迁移清理标记）：
   * 历史上壳在 localStorage（novel.trash.<workDir>）自跟踪软删条目，现改由 domain list_trash
   * 提供真相；首次 list_trash 成功后清掉旧 key 作废残留数据，之后不再重复删。
   */
  private trashLegacyCleaned = false;
  /** 开章代际：防竞态——快速连开两章时，先发的 read_chapter 后 resolve 不覆盖后点的章。 */
  private openSeq = 0;
  /** 在飞保存 promise（并发 saveCurrent 等在飞的完成再重入，防吞脏保存）；无在飞为 null。 */
  private savingPromise: Promise<boolean> | null = null;

  init(client: CoreClient, workDir: string): void {
    this.client = client;
    this.workDir = workDir;
  }

  registerEditor(api: EditorApi | null): void {
    this.editorApi = api;
  }

  /** 当前编辑器正文；未挂载时由调用方回退到已保存正文。 */
  editorApiText(): string | null {
    return this.editorApi?.getMd() ?? null;
  }

  /** 等编辑器挂载就位（开章后应用候选前用）；超时返回 false。 */
  async whenEditorReady(timeoutMs = 3000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.editorApi) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  /** 把候选的 proposed 替换进当前编辑器正文（按 original 唯一定位）。 */
  applyEdit(original: string, proposed: string): 'ok' | 'not-found' | 'ambiguous' | 'no-editor' {
    if (!this.editorApi) return 'no-editor';
    return this.editorApi.applyEdit(original, proposed);
  }

  /** kind=append：proposed 追加到编辑器文档末尾。 */
  appendMd(md: string): 'ok' | 'not-found' | 'no-editor' {
    if (!this.editorApi) return 'no-editor';
    return this.editorApi.appendMd(md);
  }

  /** kind=replace_all：proposed 整体替换编辑器正文。 */
  replaceBodyMd(md: string): 'ok' | 'not-found' | 'no-editor' {
    if (!this.editorApi) return 'no-editor';
    return this.editorApi.replaceBodyMd(md);
  }

  dismissError(): void {
    this.error = null;
  }
  dismissNotice(): void {
    this.notice = null;
  }

  /** 按 relPath 找结构树里的章节点（采纳候选开章用）。 */
  findChapter(relPath: string): ChapterNode | null {
    for (const v of this.structure) {
      for (const ch of v.children) if (ch.relPath === relPath) return ch;
    }
    return null;
  }

  /** 按 frontmatter 稳定 id 找章（B7：重排改名不失效）。 */
  findChapterById(id: string): ChapterNode | null {
    for (const v of this.structure) {
      for (const ch of v.children) if (ch.id === id) return ch;
    }
    return null;
  }

  /** 当前章的目标字数（B5，frontmatter goal）。 */
  currentGoal(): number | null {
    const g = this.current?.goal ?? this.findChapter(this.current?.relPath ?? '')?.goal;
    return typeof g === 'number' && g > 0 ? g : null;
  }

  async loadStructure(): Promise<void> {
    this.loading = true;
    try {
      this.structure = await this.client.callTool<VolumeNode[]>('list_structure', {
        workDir: this.workDir,
      });
    } catch (err) {
      this.error = `加载结构树失败：${err instanceof Error ? err.message : String(err)}`;
      throw err;
    } finally {
      this.loading = false;
    }
  }

  /** 打开一章；有未保存改动先自动落盘（失败则不切换，显式报错留在当前章）。 */
  async openChapter(ch: ChapterNode, sceneTitle?: string): Promise<void> {
    if (this.current?.relPath === ch.relPath && !sceneTitle) return;
    if (this.dirty) await this.saveCurrent();
    if (this.error) return;
    const seq = ++this.openSeq; // 本次开章代际：并发连开两章，先发的读回落后按代际丢弃
    try {
      const r = await this.client.callTool<ReadChapterResult>('read_chapter', {
        workDir: this.workDir,
        relPath: ch.relPath,
      });
      if (seq !== this.openSeq) return; // 陈旧读回（有更新的开章请求）：丢弃，不覆盖后点章现场
      const open: OpenChapter = {
        relPath: ch.relPath,
        title: ch.title,
        frontmatterRaw: r.frontmatterRaw,
        frontmatter: r.frontmatter,
        savedMd: r.body,
      };
      if (typeof r.frontmatter.goal === 'number') open.goal = r.frontmatter.goal;
      if (typeof r.frontmatter.id === 'string') open.id = r.frontmatter.id;
      this.current = open;
      this.pendingScene = sceneTitle ?? null;
      this.currentScene = sceneTitle ?? null;
      this.dirty = false;
    } catch (err) {
      this.error = `打开章节失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * 保存当前章：进入时对章做快照，全程用该快照的 relPath/frontmatterRaw + 编辑器现场 md 写盘。
   * 完成后仅当仍是该章（current===快照）才回写 savedMd/清 dirty；若期间已切到别的章，盘照写但不碰新章状态。
   * 并发互斥：「等在飞保存完成再重入」而非直接 return false，避免吞掉第二次脏保存；无环故不造死锁。
   */
  async saveCurrent(): Promise<boolean> {
    const cur = this.current;
    if (!cur) return false;
    // 有在飞保存：等它结束再按当前章重新执行（此时 current 可能已是别章，照新快照保存）
    if (this.savingPromise) {
      await this.savingPromise.catch(() => undefined);
      return this.saveCurrent();
    }
    const md = this.editorApi?.getMd() ?? cur.savedMd;
    this.saving = true;
    this.error = null;
    const run = (async () => {
      try {
        await this.client.callTool('write_chapter', {
          workDir: this.workDir,
          relPath: cur.relPath,
          content: cur.frontmatterRaw + md,
        });
        // 仅当仍是当前章才回写 savedMd/清脏；A 保存期间已切到 B 章 → B 的脏标不被 A 误清
        if (this.current === cur) {
          cur.savedMd = md;
          this.dirty = false;
        }
        void this.loadStructure().catch(() => undefined); // 字数/场景可能变了，后台刷树（失败红条已在 loadStructure 内）
        void this.client.recordStatsSnapshot(this.workDir).catch(() => undefined);
        return true;
      } catch (err) {
        // 保存失败：仅当仍是原章才报红条 + 保留脏标（已切章则不污染新章状态）
        if (this.current === cur) {
          this.error = `保存失败：${err instanceof Error ? err.message : String(err)}`;
        }
        return false;
      } finally {
        this.saving = false;
      }
    })();
    this.savingPromise = run;
    try {
      return await run;
    } finally {
      if (this.savingPromise === run) this.savingPromise = null;
    }
  }

  /**
   * 章发布状态三态流转（任务 2，纯壳侧）：无 status/未知值 → 草稿 → 已发布 → 已校对 → 草稿（回环）。
   * 只改 frontmatterRaw 的 status 行（其余键字节级保留，见 frontmatter.ts），随后复用 saveCurrent
   * 落盘（快照/原子写/刷树全走既有路径，不另调 domain 工具）；保存失败回滚现场，pill 不显示未落盘的态。
   */
  async cycleChapterStatus(): Promise<boolean> {
    const cur = this.current;
    if (!cur) return false;
    const status = typeof cur.frontmatter.status === 'string' ? cur.frontmatter.status : undefined;
    const next = nextChapterStatus(status);
    const prevRaw = cur.frontmatterRaw;
    const prevFm = cur.frontmatter;
    cur.frontmatterRaw = setFrontmatterStatus(prevRaw, next);
    cur.frontmatter = { ...prevFm, status: next };
    const ok = await this.saveCurrent();
    if (!ok && this.current === cur) {
      cur.frontmatterRaw = prevRaw;
      cur.frontmatter = prevFm;
    }
    return ok;
  }

  /** 码字日历数据（Toolbar 日历下拉打开时拉取）；失败抛出，由调用方静默降级「暂无数据」。 */
  dailyStats(): Promise<DailyStats> {
    return this.client.getDailyStats(this.workDir);
  }

  /**
   * 平台格式复制（任务 3）：export_chapter_text 取 {title, text}（text=章标题+两换行+平台格式正文，
   * core 已 unwrap），写剪贴板（Tauri 插件优先、Web Clipboard 回落）。成功返回 true（按钮短暂反馈）；
   * 失败进红条（可行动提示）并返回 false。
   */
  async copyChapterText(): Promise<boolean> {
    const cur = this.current;
    if (!cur) return false;
    try {
      const r = await this.client.callTool<{ title: string; text: string }>('export_chapter_text', {
        workDir: this.workDir,
        relPath: cur.relPath,
      });
      await writeClipboardText(r.text);
      return true;
    } catch (err) {
      this.error = `复制失败：${err instanceof Error ? err.message : String(err)}（可在正文全选后手动复制）`;
      return false;
    }
  }

  /** 软删：文件进 .novel/trash/，永不物理删除；找回=从 trash 移回原路径。 */
  async deleteChapter(relPath: string): Promise<void> {
    this.error = null;
    try {
      const r = await this.client.callTool<{ trashPath: string }>('delete_chapter', {
        workDir: this.workDir,
        relPath,
      });
      if (this.current?.relPath === relPath) {
        this.current = null;
        this.dirty = false;
      }
      void this.refreshTrash(); // 回收站列表以 domain 为真相源，删除成功后后台重拉（失败静默）
      this.notice = `已移入回收站 ${r.trashPath}（移回原路径即找回）`;
      await this.loadStructure();
    } catch (err) {
      this.error = `删除失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** 全稿导出 txt（安全阀），导出文件在作品文件夹根。 */
  async exportAll(): Promise<void> {
    this.error = null;
    try {
      const r = await this.client.callTool<{ path: string; chapters: number }>('export_txt', {
        workDir: this.workDir,
      });
      this.notice = `已导出 ${r.chapters} 章到 ${r.path}（作品文件夹根）`;
    } catch (err) {
      this.error = `导出失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ---------- A 组 · 章/卷生产与组织（domain create/rename/move） ----------

  /** A1 新建章（自动接续卷内编号 + frontmatter 模板）；volume 省略 → manuscript 根。 */
  async createChapter(volume: string | null, title?: string, goal?: number): Promise<string | null> {
    this.error = null;
    try {
      const r = await this.client.callTool<{ ok: boolean; relPath: string }>('create_chapter', {
        workDir: this.workDir,
        volume: volume ?? '',
        ...(title ? { title } : {}),
        ...(goal ? { goal } : {}),
      });
      await this.loadStructure();
      this.notice = `已新建 ${r.relPath}`;
      return r.relPath;
    } catch (err) {
      this.error = `新建章失败：${err instanceof Error ? err.message : String(err)}`;
      return null;
    }
  }

  /** A1 新建卷。 */
  async createVolume(title?: string): Promise<string | null> {
    this.error = null;
    try {
      const r = await this.client.callTool<{ ok: boolean; volumePath: string }>('create_volume', {
        workDir: this.workDir,
        ...(title ? { title } : {}),
      });
      await this.loadStructure();
      this.notice = `已新建卷 ${r.volumePath}`;
      return r.volumePath;
    } catch (err) {
      this.error = `新建卷失败：${err instanceof Error ? err.message : String(err)}`;
      return null;
    }
  }

  /** A2 重命名章（只改用户标题部分，编号不动，frontmatter title 同步）。 */
  async renameChapter(relPath: string, title: string): Promise<boolean> {
    this.error = null;
    try {
      const r = await this.client.callTool<{ ok: boolean; relPath: string }>('rename_chapter', {
        workDir: this.workDir,
        relPath,
        title,
      });
      await this.loadStructure();
      // 重命名后若正开着该章，title / relPath 跟随（章头 + 顶栏展示同步）
      if (this.current?.relPath === relPath) {
        this.current = { ...this.current, relPath: r.relPath, title };
      }
      return true;
    } catch (err) {
      this.error = `重命名失败：${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  /** A2 重命名卷。 */
  async renameVolume(volumePath: string, title: string): Promise<boolean> {
    this.error = null;
    try {
      await this.client.callTool('rename_volume', { workDir: this.workDir, volumePath, title });
      await this.loadStructure();
      return true;
    } catch (err) {
      this.error = `重命名卷失败：${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  /** A3 卷内拖拽重排（事务化重编号；跨卷不支持）。 */
  async moveChapter(relPath: string, toIndex: number): Promise<boolean> {
    this.error = null;
    try {
      await this.client.callTool('move_chapter', { workDir: this.workDir, relPath, toIndex });
      await this.loadStructure();
      return true;
    } catch (err) {
      this.error = `移动失败：${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  /** A3 卷排序（改目录名前缀）。 */
  async moveVolume(volumePath: string, toIndex: number): Promise<boolean> {
    this.error = null;
    try {
      await this.client.callTool('move_volume', { workDir: this.workDir, volumePath, toIndex });
      await this.loadStructure();
      return true;
    } catch (err) {
      this.error = `移动卷失败：${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  /** B1 插入其后：把 proposed 插到 original 之后（原文保留）。 */
  insertAfter(original: string, proposed: string): 'ok' | 'not-found' | 'ambiguous' | 'no-editor' {
    if (!this.editorApi?.insertAfter) return 'no-editor';
    return this.editorApi.insertAfter(original, proposed);
  }

  // ---------- 回收站：domain list_trash 为真相源，refreshTrash 拉取；找回=读 trash 写回 originalPath ----------
  // 兼容窗口期：core 旧版没有 list_trash 工具时 refreshTrash 失败 → 静默保留空列表，面板显示为空。
  /**
   * 拉取回收站条目写入 trashEntries。失败静默（console.warn 留痕），不打扰界面。
   * 首次成功后清掉旧壳侧 localStorage 残留 key（novel.trash.<workDir>，一次性迁移清理）。
   */
  async refreshTrash(): Promise<void> {
    try {
      const r = await this.client.callTool<{ entries: TrashEntry[] }>('list_trash', {
        workDir: this.workDir,
      });
      this.trashEntries = r.entries ?? [];
      if (!this.trashLegacyCleaned && typeof localStorage !== 'undefined') {
        this.trashLegacyCleaned = true;
        try {
          // 迁移清理：壳侧旧跟踪数据与 domain 真相源可能不一致（换设备/清库等），直接作废删除
          localStorage.removeItem(`novel.trash.${this.workDir}`);
        } catch {
          // 隐私模式等 removeItem 失败：忽略，不影响列表展示
        }
      }
    } catch (err) {
      console.warn('[trash] list_trash 失败，保留当前回收站列表：', err);
    }
  }

  async restoreTrash(trashPath: string): Promise<boolean> {
    const entry = this.trashEntries.find((e) => e.trashPath === trashPath);
    if (!entry) {
      this.error = '回收站条目不存在（可能已被恢复）';
      return false;
    }
    if (!entry.originalPath) {
      // 无时间戳垃圾文件等拿不到原路径：无法自动写回，提示手动处理
      this.notice = `该条目无法还原原路径，请到 .novel/trash/ 手动处理（${entry.name}）`;
      return false;
    }
    this.error = null;
    try {
      const r = await this.client.callTool<{ content: string }>('read_chapter', {
        workDir: this.workDir,
        relPath: entry.trashPath,
      });
      await this.client.callTool('write_chapter', {
        workDir: this.workDir,
        relPath: entry.originalPath,
        content: r.content,
      });
      void this.refreshTrash(); // 后台重拉列表（失败静默）。注意：找回=读回写非移动，trash 副本仍在回收站里
      this.notice = `已找回 ${entry.originalPath}（写回原路径；trash 副本仍保留，可从回收站手动清理）`;
      await this.loadStructure();
      return true;
    } catch (err) {
      this.error = `找回失败：${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  /**
   * 重载当前章（快照还原、AI 直写放行等磁盘回写后刷新现场）。
   * 与 openChapter 不同：跳过脏保存门禁，直接以磁盘内容为准，避免旧编辑器内容写回覆盖磁盘。
   */
  async reloadCurrent(): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    this.error = null;
    try {
      const r = await this.client.callTool<ReadChapterResult>('read_chapter', {
        workDir: this.workDir,
        relPath: cur.relPath,
      });
      const node = this.findChapter(cur.relPath);
      const open: OpenChapter = {
        relPath: cur.relPath,
        title: node?.title ?? cur.title,
        frontmatterRaw: r.frontmatterRaw,
        frontmatter: r.frontmatter,
        savedMd: r.body,
      };
      if (typeof r.frontmatter.goal === 'number') open.goal = r.frontmatter.goal;
      if (typeof r.frontmatter.id === 'string') open.id = r.frontmatter.id;
      this.current = open;
      this.pendingScene = null;
      this.currentScene = null;
      this.dirty = false;
      this.reloadNonce++;
    } catch (err) {
      this.error = `重载章节失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export const work = new WorkStore();