/**
 * chat.svelte.ts —— AI 讨论（第 3 周：双讨论存区）。
 * scope='' 无归属讨论 / scope=章 relPath 章节内讨论；会话持久化在 core（重启可恢复）。
 * text-delta 由 CoreClient 内部 DeltaBatcher 批次后回调，这里只追加到消息。
 */
import type { CoreClient } from './core.js';
import type { SessionRow } from './types.js';
import { work } from './work.svelte.js';

export interface ToolLine {
  id: string;
  name: string;
  done: boolean;
}

export interface ChatMsg {
  role: 'user' | 'assistant' | 'error';
  content: string;
  tools?: ToolLine[];
}

export class ChatStore {
  /** 当前讨论归属（''=无归属；章 relPath=章节内）。 */
  scope = $state('');
  /** 当前归属下的会话列表（最近更新在前）。 */
  sessions = $state<SessionRow[]>([]);
  sessionId = $state<string | null>(null);
  messages = $state<ChatMsg[]>([]);
  streaming = $state(false);

  private client!: CoreClient;

  init(client: CoreClient): void {
    this.client = client;
  }

  /** 切换讨论存区：清空现场，加载该归属的会话，自动打开最近一个。 */
  async setScope(scope: string): Promise<void> {
    if (scope === this.scope && this.sessionId !== null) return;
    this.scope = scope;
    this.sessionId = null;
    this.messages = [];
    await this.loadSessions();
    const latest = this.sessions[0];
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
    try {
      const r = await this.client.sessionMessages(id);
      this.messages = r.messages.map((m) => ({
        role: m.role,
        content: m.content,
        tools: (m.toolCalls ?? []).map((t) => ({ id: t.id, name: t.name, done: true })),
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
          this.messages[idx]?.tools?.push({ id: c.id, name: c.name, done: false });
        },
        onToolResult: (r) => {
          const tool = this.messages[idx]?.tools?.find((t) => t.id === r.id);
          if (tool) tool.done = true;
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