/**
 * chat.svelte.ts —— AI 讨论：任意层级挂载（B7：作品根/卷/章稳定 id）、会话搜索/重命名/归档、
 * 工具调用卡片化数据（B3/B10）、危险工具分级审批联动（B6）。
 *
 * scope 编码（壳私有约定，core 只存不解释）：''=无归属；`ch:<章 frontmatter id>`=章节内
 * （章重排改名不失效）；`vol:<卷目录名>`=卷内；`work`=作品根。
 * 会话重命名/归档是壳产品逻辑（core 不为此加逻辑）：overlay 存 localStorage，
 * 改名覆盖显示标题、归档从列表隐藏。
 */
import type { CoreClient } from './core.js';
import type { SessionRow } from './types.js';
import { approval } from './approval.svelte.js';
import { settings } from './settings.svelte.js';
import { snapshot } from './snapshot.svelte.js';
import { work } from './work.svelte.js';

export type ToolState = 'running' | 'done' | 'pending' | 'rejected';

export interface ToolLine {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  state: ToolState;
}

export interface ChatMsg {
  role: 'user' | 'assistant' | 'error';
  content: string;
  tools?: ToolLine[];
}

/** 会话 overlay（壳私有：重命名/归档，core 会话库不动）。 */
interface SessionMeta {
  title?: string;
  archived?: boolean;
}

const META_KEY = 'novel.sessionMeta';

function loadMeta(): Record<string, SessionMeta> {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) ?? '{}') as Record<string, SessionMeta>;
  } catch {
    return {};
  }
}

export class ChatStore {
  /** 当前讨论归属（编码见文件头）。 */
  scope = $state('');
  /** 当前归属下的会话列表（最近更新在前）。 */
  sessions = $state<SessionRow[]>([]);
  sessionId = $state<string | null>(null);
  messages = $state<ChatMsg[]>([]);
  streaming = $state(false);
  /** 会话列表搜索词（B7）。 */
  searchText = $state('');
  /** 重命名中的会话 id（行内输入态）。 */
  renamingId = $state<string | null>(null);
  renameDraft = $state('');

  /** 显示层会话列表：归档隐藏 + 搜索过滤。 */
  visibleSessions = $derived.by(() => {
    const meta = loadMeta();
    const q = this.searchText.trim().toLowerCase();
    return this.sessions.filter((s) => {
      const m = meta[s.id];
      if (m?.archived) return false;
      if (!q) return true;
      const title = this.sessionTitle(s);
      return title.toLowerCase().includes(q) || s.scope.includes(q);
    });
  });

  private client!: CoreClient;
  private meta: Record<string, SessionMeta> = loadMeta();

  init(client: CoreClient): void {
    this.client = client;
  }

  private saveMeta(): void {
    localStorage.setItem(META_KEY, JSON.stringify(this.meta));
  }

  sessionTitle(s: SessionRow): string {
    return this.meta[s.id]?.title || s.title || '（未命名）';
  }

  /** 当前挂载点的人类可读标签（会话栏/对话栏标题用）。 */
  scopeLabel(): string {
    if (this.scope === '') return '无归属';
    if (this.scope === 'work') return '作品根';
    if (this.scope.startsWith('vol:')) return this.scope.slice(4);
    if (this.scope.startsWith('ch:')) {
      const key = this.scope.slice(3);
      const node = work.findChapterById(key) ?? work.findChapter(key);
      return node?.title ?? '本章';
    }
    return this.scope;
  }

  /** 切换讨论存区：清空现场，加载该归属的会话，自动打开最近一个。 */
  async setScope(scope: string): Promise<void> {
    if (scope === this.scope && this.sessionId !== null) return;
    this.scope = scope;
    this.sessionId = null;
    this.messages = [];
    await this.loadSessions();
    const latest = this.visibleSessions[0];
    if (latest) await this.openSession(latest.id);
  }

  async loadSessions(): Promise<void> {
    try {
      const r = await this.client.listSessions(this.scope);
      this.sessions = r.sessions;
    } catch {
      this.sessions = []; // 列表失败不挡聊天主链路
    }
  }

  /** 打开历史会话（重启恢复 / 列表点选）。 */
  async openSession(id: string): Promise<void> {
    this.sessionId = id;
    this.renamingId = null;
    try {
      const r = await this.client.sessionMessages(id);
      this.messages = r.messages.map((m) => ({
        role: m.role,
        content: m.content,
        tools: (m.toolCalls ?? []).map((t) => ({ id: t.id, name: t.name, args: t.args, state: 'done' as ToolState })),
      }));
    } catch (err) {
      this.messages = [
        { role: 'error', content: `会话读取失败：${err instanceof Error ? err.message : String(err)}` },
      ];
    }
  }

  newSession(): void {
    this.sessionId = null;
    this.messages = [];
  }

  /** B7 重命名：行内编辑态进入 / 提交 / 取消。 */
  startRename(id: string): void {
    const s = this.sessions.find((x) => x.id === id);
    this.renamingId = id;
    this.renameDraft = s ? this.sessionTitle(s) : '';
  }

  commitRename(): void {
    if (!this.renamingId) return;
    const title = this.renameDraft.trim();
    if (title) {
      this.meta[this.renamingId] = { ...this.meta[this.renamingId], title };
      this.saveMeta();
    }
    this.renamingId = null;
  }

  cancelRename(): void {
    this.renamingId = null;
  }

  /** B7 归档：从列表隐藏（记录与消息仍在 core 库中）。 */
  archiveSession(id: string): void {
    this.meta[id] = { ...this.meta[id], archived: true };
    this.saveMeta();
    if (this.sessionId === id) this.newSession();
  }

  /**
   * B6 审批裁决：允许一次 / 允许本会话 / 拒绝（拒绝走补偿还原）。
   * 拒绝语义（core 在事件流内已执行，壳做撤销）：write_chapter → 事前快照还原；
   * delete_chapter → 从 .novel/trash/ 读回原内容写回原路径；export_txt → 提示文件保留路径。
   */
  async resolveApproval(verdict: 'once' | 'session' | 'reject'): Promise<void> {
    const req = approval.active;
    if (!req) return;
    if (verdict === 'reject') {
      await this.rejectApproval(req);
    }
    approval.resolve(req.callId, verdict);
  }

  private async rejectApproval(req: { callId: string; name: string; args: Record<string, unknown> }): Promise<void> {
    // 该调用对应的工具卡落定为 rejected（结果已到则保留结果就地审阅）
    for (const m of this.messages) {
      for (const t of m.tools ?? []) {
        if (t.id === req.callId) t.state = 'rejected';
      }
    }
    try {
      if (req.name === 'write_chapter') {
        const rel = typeof req.args.relPath === 'string' ? req.args.relPath : '';
        if (rel) {
          const ok = await snapshot.restoreLatest(rel);
          if (ok) work.notice = `已拒绝 AI 直写并还原 ${rel}（事前快照）`;
        }
      } else if (req.name === 'delete_chapter') {
        const rel = typeof req.args.relPath === 'string' ? req.args.relPath : '';
        if (rel) {
          // 删除是软删：从 trash 里找回最新一份同名内容写回原路径（read_chapter 不限 manuscript）
          const trashPath = this.trashPathOf(req.callId, rel);
          if (trashPath) {
            const r = await this.client.callTool<{ content: string }>('read_chapter', {
              workDir: work.workDir,
              relPath: trashPath,
            });
            await this.client.callTool('write_chapter', {
              workDir: work.workDir,
              relPath: rel,
              content: r.content,
            });
            await work.loadStructure();
            work.notice = `已拒绝 AI 删章并找回 ${rel}（trash 副本还原，trash 里仍留备份）`;
          } else {
            work.notice = `已拒绝 AI 删章；未找到 trash 副本，${rel} 仍在回收站`;
          }
        }
      } else if (req.name === 'export_txt') {
        work.notice = '已拒绝 AI 导出；如已生成导出文件，保留在作品文件夹根，可自行删除';
      }
    } catch (err) {
      work.error = `拒绝补偿失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** 找该调用的工具结果里的 trashPath（delete_chapter 返回 { trashPath }）。 */
  private trashPathOf(callId: string, rel: string): string | null {
    for (const m of this.messages) {
      for (const t of m.tools ?? []) {
        if (t.id !== callId || t.state === 'rejected') continue;
        const r = t.result as { trashPath?: string } | null | undefined;
        if (r?.trashPath) return r.trashPath;
      }
    }
    // 结果未到（流中断）：按 relPath 拍平推导 trash 文件名不可靠，放弃自动找回
    void rel;
    return null;
  }

  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.streaming) return;
    this.messages.push({ role: 'user', content: trimmed });
    this.messages.push({ role: 'assistant', content: '', tools: [] });
    const idx = this.messages.length - 1;
    this.streaming = true;
    const scopeAtSend = this.scope; // 流式期间切存区：结果不回写现场，但服务端会话已完整落库
    try {
      const body = this.sessionId
        ? { sessionId: this.sessionId, text: trimmed, workDir: work.workDir }
        : { text: trimmed, workDir: work.workDir, scope: this.scope };
      await this.client.chatStream(body, {
        onDelta: (t) => {
          const m = this.messages[idx];
          if (m) m.content += t;
        },
        onToolCall: (c) => {
          const m = this.messages[idx];
          if (!m) return;
          // B6 审批门：危险工具按当前模式裁决（ask 弹卡 / auto 查会话放行表 / yolo 直放）。
          // 工具实际已在 core 内执行完（约束见 approval.ts 头注）；卡先显挂起，等裁决后落定。
          const args = (c.args ?? {}) as Record<string, unknown>;
          const decision = approval.decide(c.id, c.name, args, settings.approvalMode);
          m.tools?.push({
            id: c.id,
            name: c.name,
            args: c.args,
            state: decision === 'pending' ? 'pending' : 'running',
          });
        },
        onToolResult: (r) => {
          const m = this.messages[idx];
          const tool = m?.tools?.find((t) => t.id === r.id);
          if (!tool) return;
          tool.result = r.result;
          if (tool.state !== 'pending' && tool.state !== 'rejected') tool.state = 'done';
        },
        onDone: (d) => {
          if (this.scope === scopeAtSend) {
            this.sessionId = d.sessionId;
            void this.loadSessions(); // 新会话进列表/标题排序刷新
          }
        },
        onError: (err) => {
          this.messages.push({ role: 'error', content: `服务端错误：${err.message}` });
        },
      });
    } catch (err) {
      this.messages.push({
        role: 'error',
        content: `请求失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      this.streaming = false;
      const m = this.messages[idx];
      if (m && m.content === '' && (m.tools?.length ?? 0) === 0) {
        this.messages.splice(idx, 1);
      }
    }
  }
}

export const chat = new ChatStore();
