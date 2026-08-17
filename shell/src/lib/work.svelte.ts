/**
 * work.svelte.ts —— 作品数据面：结构树、当前章、保存/删除/导出。
 * 壳零产品逻辑的落点：结构/字数/快照/软删/导出全部调 domain 工具（经 core 代理），这里只搬数据。
 */
import type { CoreClient } from './core.js';
import type { ChapterNode, ReadChapterResult, VolumeNode } from './types.js';

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

/** 软删条目：原章节路径与 trash 副本路径。domain 没有 list_trash，壳在 localStorage 跟踪。 */
export interface TrashEntry {
  /** 原章节相对 workDir 路径（manuscript/.../*.md），找回时写回此路径。 */
  relPath: string;
  /** 软删后 trash 副本路径（.novel/trash/<...>.md）。 */
  trashPath: string;
  /** 删除时间戳（ms）。 */
  deletedAt: number;
}

/** localStorage key（per-workDir）。 */
function trashKey(workDir: string): string {
  return `novel.trash.${workDir}`;
}

function loadTrashEntries(workDir: string): TrashEntry[] {
  if (!workDir || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(trashKey(workDir));
    if (!raw) return [];
    const arr = JSON.parse(raw) as TrashEntry[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveTrashEntries(workDir: string, entries: TrashEntry[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(trashKey(workDir), JSON.stringify(entries));
}

function recordTrashEntry(workDir: string, relPath: string, trashPath: string): void {
  const entries = loadTrashEntries(workDir);
  entries.unshift({ relPath, trashPath, deletedAt: Date.now() });
  saveTrashEntries(workDir, entries);
}

function removeTrashEntry(workDir: string, trashPath: string): void {
  const entries = loadTrashEntries(workDir).filter((e) => e.trashPath !== trashPath);
  saveTrashEntries(workDir, entries);
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

  private client!: CoreClient;
  /** 编辑器现场入口（Editor 挂载时注册，卸载时清空）：序列化 md + 候选文本替换。 */
  private editorApi: EditorApi | null = null;

  init(client: CoreClient, workDir: string): void {
    this.client = client;
    this.workDir = workDir;
  }

  registerEditor(api: EditorApi | null): void {
    this.editorApi = api;
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
    try {
      const r = await this.client.callTool<ReadChapterResult>('read_chapter', {
        workDir: this.workDir,
        relPath: ch.relPath,
      });
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
   * 保存当前章：md 由编辑器现场序列化（未开编辑器回落 savedMd），拼回 frontmatterRaw 后走 write_chapter。
   * 失败显式报错并保留脏标记，不吞错。
   */
  async saveCurrent(): Promise<boolean> {
    if (!this.current || this.saving) return false;
    const md = this.editorApi?.getMd() ?? this.current.savedMd;
    this.saving = true;
    this.error = null;
    try {
      await this.client.callTool('write_chapter', {
        workDir: this.workDir,
        relPath: this.current.relPath,
        content: this.current.frontmatterRaw + md,
      });
      this.current.savedMd = md;
      this.dirty = false;
      void this.loadStructure().catch(() => undefined); // 字数/场景可能变了，后台刷树（失败红条已在 loadStructure 内）
      return true;
    } catch (err) {
      this.error = `保存失败：${err instanceof Error ? err.message : String(err)}`;
      return false;
    } finally {
      this.saving = false;
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
      recordTrashEntry(this.workDir, relPath, r.trashPath);
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

  // ---------- 回收站：localStorage 跟踪软删条目，listTrash/restoreTrash 供 TreeView 面板用 ----------
  // 约束：domain 没有 list_trash 工具（本任务不新加 domain 工具），回收站面板用壳私有 localStorage 跟踪已软删过的章；
  // 找回复用 read_chapter（特许读 .novel/trash/）→ write_chapter 写回原路径，参照 chat.svelte.ts 的删章补偿逻辑。
  listTrash(): TrashEntry[] {
    return loadTrashEntries(this.workDir);
  }

  async restoreTrash(trashPath: string): Promise<boolean> {
    const entry = loadTrashEntries(this.workDir).find((e) => e.trashPath === trashPath);
    if (!entry) {
      this.error = '回收站条目不存在（可能已被恢复）';
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
        relPath: entry.relPath,
        content: r.content,
      });
      removeTrashEntry(this.workDir, entry.trashPath);
      this.notice = `已找回 ${entry.relPath}（trash 副本移回）`;
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