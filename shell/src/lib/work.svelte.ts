/**
 * work.svelte.ts —— 作品数据面：结构树、当前章、保存/删除/导出。
 * 壳零产品逻辑的落点：结构/字数/快照/软删/导出全部调 domain 工具（经 core 代理），这里只搬数据。
 */
import type { CoreClient } from './core.js';
import type { ChapterNode, ReadChapterResult, VolumeNode } from './types.js';

/** 编辑器现场入口：序列化 + 候选替换（original 唯一定位，替换为 proposed）。 */
export interface EditorApi {
  getMd: () => string;
  applyEdit: (original: string, proposed: string) => 'ok' | 'not-found' | 'ambiguous';
}

export interface OpenChapter {
  relPath: string;
  title: string;
  /** 原样保留的 frontmatter 文本块，保存时字节级回拼。 */
  frontmatterRaw: string;
  /** 打开时的正文 md（脏检查基准）。 */
  savedMd: string;
}

export class WorkStore {
  workDir = $state('');
  workName = $derived(this.workDir.split(/[\\/]/).filter(Boolean).pop() ?? '');
  structure = $state<VolumeNode[]>([]);
  current = $state<OpenChapter | null>(null);
  /** 待跳转的场景标题（打开章后由 Editor 消费）。 */
  pendingScene = $state<string | null>(null);
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

  async loadStructure(): Promise<void> {
    this.structure = await this.client.callTool<VolumeNode[]>('list_structure', {
      workDir: this.workDir,
    });
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
      this.current = {
        relPath: ch.relPath,
        title: ch.title,
        frontmatterRaw: r.frontmatterRaw,
        savedMd: r.body,
      };
      this.pendingScene = sceneTitle ?? null;
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
      void this.loadStructure(); // 字数/场景可能变了，后台刷树
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
}

export const work = new WorkStore();