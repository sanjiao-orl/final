// 模块职责：暂存候选（AI 产出进暂存区）的持久化——与 sessions 同库（sessions.sqlite），
// 候选生命周期：pending → adopted / discarded；整改 = 更新 proposed/instruction，状态保持 pending。
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SESSIONS_TABLE_DDL } from './session-store.js';

export type CandidateStatus = 'pending' | 'adopted' | 'discarded';

/** 候选形态：replace=锚定替换（现状）；append=追加章正文末尾；replace_all=替换整章正文（frontmatter 由壳在保存时保留）。 */
export type CandidateKind = 'replace' | 'append' | 'replace_all';

export interface CandidateRow {
  id: string;
  /** 来源讨论会话（可空：选区浮动条发起的改写没有讨论上下文）。 */
  sessionId: string | null;
  /** 目标章 relPath。 */
  chapter: string;
  /** 选中时的原文（锚定+预览；采纳时按它在正文里定位；append/replace_all 可空）。 */
  original: string;
  /** AI 建议替换文本。 */
  proposed: string;
  /** 当时的改写指令（整改时追加记录）。 */
  instruction: string;
  status: CandidateStatus;
  /** 候选形态，创建后不可变。 */
  kind: CandidateKind;
  createdAt: string;
  updatedAt: string;
}

export interface NewCandidate {
  chapter: string;
  original: string;
  proposed: string;
  instruction?: string | undefined;
  sessionId?: string | undefined;
  /** 缺省 'replace'=锚定替换（与既有生产路径一致）。 */
  kind?: CandidateKind | undefined;
}

/** 整改：换新建议文本，指令追加留痕；状态保持 pending。 */
export interface CandidatePatch {
  status?: CandidateStatus | undefined;
  proposed?: string | undefined;
  instruction?: string | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  chapter TEXT NOT NULL,
  original TEXT NOT NULL,
  proposed TEXT NOT NULL,
  instruction TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'adopted', 'discarded')),
  kind TEXT NOT NULL DEFAULT 'replace' CHECK (kind IN ('replace', 'append', 'replace_all')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_candidates_chapter ON candidates(chapter, status);
`;

interface DbCandidateRow {
  id: string;
  session_id: string | null;
  chapter: string;
  original: string;
  proposed: string;
  instruction: string;
  status: string;
  kind: string;
  created_at: string;
  updated_at: string;
}

export class CandidateStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 2000;'); // 与 SessionStore 同库双连接，写操作瞬时，兜底防锁
    db.exec(SESSIONS_TABLE_DDL); // 外键父表，CandidateStore 独立打开库时也要先存在
    db.exec(SCHEMA);
    // 旧库迁移：候选模型扩展（铁律回归批）之前的 candidates 表没有 kind 列，缺则补上（默认 'replace'=锚定替换，既有行语义不变）。
    const cols = db.prepare('PRAGMA table_info(candidates)').all() as unknown as { name: string }[];
    if (!cols.some((c) => c.name === 'kind')) {
      db.exec("ALTER TABLE candidates ADD COLUMN kind TEXT NOT NULL DEFAULT 'replace' CHECK (kind IN ('replace', 'append', 'replace_all'))");
    }
    this.db = db;
  }

  create(c: NewCandidate): CandidateRow {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO candidates (id, session_id, chapter, original, proposed, instruction, status, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, c.sessionId ?? null, c.chapter, c.original, c.proposed, c.instruction ?? '', 'pending', c.kind ?? 'replace', now, now);
    return this.get(id)!;
  }

  get(id: string): CandidateRow | undefined {
    const row = this.db.prepare('SELECT * FROM candidates WHERE id = ?').get(id) as DbCandidateRow | undefined;
    return row ? mapCandidate(row) : undefined;
  }

  /** 列表按最近更新倒序；status / chapter 过滤可组合。 */
  list(filter: { status?: CandidateStatus | undefined; chapter?: string | undefined } = {}): CandidateRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.status !== undefined) {
      where.push('status = ?');
      args.push(filter.status);
    }
    if (filter.chapter !== undefined) {
      where.push('chapter = ?');
      args.push(filter.chapter);
    }
    const sql =
      'SELECT * FROM candidates' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY updated_at DESC, id DESC';
    const rows = this.db.prepare(sql).all(...args) as unknown as DbCandidateRow[];
    return rows.map(mapCandidate);
  }

  /** 更新并刷新 updated_at；候选不存在返回 undefined。 */
  patch(id: string, patch: CandidatePatch): CandidateRow | undefined {
    const sets: string[] = [];
    const args: (string | null)[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      args.push(patch.status);
    }
    if (patch.proposed !== undefined) {
      sets.push('proposed = ?');
      args.push(patch.proposed);
    }
    if (patch.instruction !== undefined) {
      sets.push('instruction = ?');
      args.push(patch.instruction);
    }
    if (sets.length === 0) return this.get(id);
    sets.push('updated_at = ?');
    args.push(new Date().toISOString(), id);
    const res = this.db.prepare(`UPDATE candidates SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    if (Number(res.changes) === 0) return undefined;
    return this.get(id);
  }

  close(): void {
    this.db.close();
  }
}

function mapCandidate(row: DbCandidateRow): CandidateRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    chapter: row.chapter,
    original: row.original,
    proposed: row.proposed,
    instruction: row.instruction,
    status: row.status as CandidateStatus,
    kind: row.kind as CandidateKind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
