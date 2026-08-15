/**
 * notes.svelte.ts —— 作者私人笔记（壳 v5 §一.2）：作者的私房话，AI 物理不可见。
 * 约束：读写只走 Tauri Rust 命令（read_note / write_note，落 <workDir>/.novel/notes/），
 * 绝不进 core/domain MCP 工具集。因此本 store 不持有 CoreClient，
 * 也不会把内容送进任何 chat / candidates / snapshot 等数据面调用。
 *
 * 浏览器开发模式（vite 直开、无 Tauri）：tauriInvoke() 不可用时 store 进入
 * unavailable 态，组件显示「桌面版可用作者笔记」空态，不报错。
 */
import { tauriInvoke } from './core.js';

export type NotesTab = 'book' | 'chapter';

/** 笔记 tab + 章稳定 id → relPath（纯函数，便于单测）：全书=book.md；本章=chapters/<id>.md。 */
export function noteRelPath(tab: NotesTab, id: string): string {
  return tab === 'chapter' ? `chapters/${id}.md` : 'book.md';
}

/**
 * 章稳定 id（纯函数，便于单测）：frontmatter 稳定 id（B7，work.current?.id）优先；
 * 拿不到 id（旧稿无 frontmatter id）时退化为 encodeURIComponent(relPath) 兜底——
 * 兜底串会带上 .md 扩展名，剥掉再拼回，保证文件名恒为 chapters/<id>.md（单扩展名）。
 */
export function chapterNoteId(current: { id?: string; relPath: string } | null | undefined): string | null {
  if (!current) return null;
  if (current.id) return current.id;
  const encoded = encodeURIComponent(current.relPath);
  return encoded.endsWith('.md') ? encoded.slice(0, -3) : encoded;
}

class NotesStore {
  /** 当前笔记内容（内存态）。 */
  content = $state('');
  /** 当前笔记 relPath（book.md 或 chapters/<id>.md）；null=尚未加载。 */
  relPath = $state<string | null>(null);
  dirty = $state(false);
  saving = $state(false);
  /** 最近一次保存完成时间戳（ms）；0=本会话还没保存过。 */
  savedAt = $state(0);
  /** 不可用（无 Tauri）：组件显示空态，不报错。 */
  unavailable = $state(false);
  /** 最近一次读写失败信息（成功保存后清掉）。 */
  error = $state<string | null>(null);

  /** 防抖自动保存定时器句柄。 */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** load 代际：防竞态——旧 load 的读回落后不覆盖新文件的现场。 */
  private loadSeq = 0;

  /**
   * 加载某份笔记：先落盘旧笔记（若有脏改动），再切到新 relPath 并读回。
   * 浏览器无 Tauri 时进入 unavailable 态。
   */
  async load(relPath: string): Promise<void> {
    await this.flush();
    this.loadSeq++;
    const seq = this.loadSeq;
    this.relPath = relPath;
    this.content = '';
    this.dirty = false;
    this.error = null;

    const invoke = tauriInvoke();
    if (!invoke) {
      this.unavailable = true;
      return;
    }
    this.unavailable = false;
    try {
      const text = await invoke<string>('read_note', { relPath });
      if (this.loadSeq !== seq) return; // 已有更新的 load 接管
      this.content = text;
    } catch (err) {
      if (this.loadSeq === seq) {
        this.error = `读取笔记失败：${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  /** 写入内存 + 置脏 + 防抖 500ms 自动保存。 */
  setContent(text: string): void {
    if (this.unavailable) return;
    this.content = text;
    this.dirty = true;
    this.error = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, 500);
  }

  /** 立即保存（清防抖）：脏且有 relPath 才落盘；成功记录 savedAt、清脏。 */
  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.unavailable || !this.dirty || !this.relPath) return;
    const invoke = tauriInvoke();
    if (!invoke) return;
    const relPath = this.relPath;
    const content = this.content;
    this.saving = true;
    this.error = null;
    try {
      await invoke('write_note', { relPath, content });
      if (this.relPath === relPath) {
        this.dirty = false;
        this.savedAt = Date.now();
      }
    } catch (err) {
      if (this.relPath === relPath) {
        // 保留脏标记：下次 flush / 切换仍会重试
        this.error = `保存笔记失败：${err instanceof Error ? err.message : String(err)}`;
      }
    } finally {
      if (this.relPath === relPath) this.saving = false;
    }
  }

  dismissError(): void {
    this.error = null;
  }
}

export const notes = new NotesStore();
