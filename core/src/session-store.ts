// 模块职责：基于 node:sqlite（Node 24 内置 DatabaseSync）的会话/消息持久化，库文件 .novel/sessions.sqlite。
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SessionRow {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRow {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: unknown[];
  createdAt: string;
}

export interface NewMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: unknown[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL DEFAULT '',
  tool_calls TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
`;

interface DbSessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface DbMessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_calls: string;
  created_at: string;
}

export class SessionStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA);
    this.db = db;
  }

  createSession(title: string): SessionRow {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, title, now, now);
    return { id, title, createdAt: now, updatedAt: now };
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.db
      .prepare('SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?')
      .get(id) as DbSessionRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  /** 会话列表，按最近更新倒序。 */
  listSessions(): SessionRow[] {
    const rows = this.db
      .prepare('SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC, id DESC')
      .all() as unknown as DbSessionRow[];
    return rows.map(mapSession);
  }

  /** 追加消息并刷新会话 updated_at；会话不存在时因外键约束抛错。 */
  addMessage(sessionId: string, msg: NewMessage): MessageRow {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO messages (id, session_id, role, content, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, msg.role, msg.content, JSON.stringify(msg.toolCalls ?? []), now);
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    return { id, sessionId, role: msg.role, content: msg.content, toolCalls: msg.toolCalls ?? [], createdAt: now };
  }

  /** 会话完整消息列表，按时间正序。 */
  listMessages(sessionId: string): MessageRow[] {
    const rows = this.db
      .prepare(
        'SELECT id, session_id, role, content, tool_calls, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC'
      )
      .all(sessionId) as unknown as DbMessageRow[];
    return rows.map(mapMessage);
  }

  close(): void {
    this.db.close();
  }
}

function mapSession(row: DbSessionRow): SessionRow {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapMessage(row: DbMessageRow): MessageRow {
  let toolCalls: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tool_calls);
    if (Array.isArray(parsed)) toolCalls = parsed;
  } catch {
    // 历史脏数据按空处理
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    toolCalls,
    createdAt: row.created_at,
  };
}
