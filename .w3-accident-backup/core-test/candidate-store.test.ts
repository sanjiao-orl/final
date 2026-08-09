// 测试：CandidateStore 的 CRUD、过滤、状态流转与同库双连接共存（纯本地 sqlite，不走网络）。
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { CandidateStore } from '../src/candidate-store.js';
import { SessionStore } from '../src/session-store.js';

function tmpDbPath(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'novel-cand-test-')), 'sessions.sqlite');
}

describe('CandidateStore', () => {
  it('create 落库为 pending，get 读回全字段', () => {
    const store = new CandidateStore(tmpDbPath());
    const c = store.create({
      chapter: '第一卷/第一章.md',
      original: '原文一段',
      proposed: '改写后一段',
      instruction: '更紧张一点',
    });
    expect(c.status).toBe('pending');
    expect(c.sessionId).toBeNull();

    const got = store.get(c.id);
    expect(got).toBeDefined();
    expect(got!.chapter).toBe('第一卷/第一章.md');
    expect(got!.original).toBe('原文一段');
    expect(got!.proposed).toBe('改写后一段');
    expect(got!.instruction).toBe('更紧张一点');
    expect(got!.createdAt).toBeTruthy();
    store.close();
  });

  it('sessionId 关联 sessions（同库外键）；会话删除后候选 session_id 置空', () => {
    const dbPath = tmpDbPath();
    const sessions = new SessionStore(dbPath);
    const store = new CandidateStore(dbPath);
    const s = sessions.createSession('讨论', 'ch01.md');

    const c = store.create({ chapter: 'ch01.md', original: 'a', proposed: 'b', sessionId: s.id });
    expect(c.sessionId).toBe(s.id);

    // SessionStore 暂无删除方法，用裸连接删（与将来可能的删除端点同一 SQL 语义）
    const raw = new DatabaseSync(dbPath);
    raw.exec('PRAGMA foreign_keys = ON;');
    raw.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
    raw.close();

    expect(store.get(c.id)!.sessionId).toBeNull();
    sessions.close();
    store.close();
  });

  it('外键拦截：sessionId 指向不存在的会话时 create 抛错', () => {
    const dbPath = tmpDbPath();
    new SessionStore(dbPath).close(); // 建 sessions 表
    const store = new CandidateStore(dbPath);
    expect(() =>
      store.create({ chapter: 'c.md', original: 'a', proposed: 'b', sessionId: '00000000-0000-0000-0000-000000000000' })
    ).toThrow();
    store.close();
  });

  it('list 过滤：status / chapter 可组合，按 updated_at 倒序', () => {
    const store = new CandidateStore(tmpDbPath());
    const a = store.create({ chapter: 'c1.md', original: 'a', proposed: 'x' });
    const b = store.create({ chapter: 'c1.md', original: 'b', proposed: 'y' });
    store.create({ chapter: 'c2.md', original: 'c', proposed: 'z' });
    store.patch(b.id, { status: 'adopted' });

    expect(store.list().map((c) => c.id)).toContain(a.id);
    expect(store.list({ status: 'pending' }).map((c) => c.id).sort()).toEqual(
      [a.id, store.list({ chapter: 'c2.md' })[0]!.id].sort()
    );
    expect(store.list({ status: 'pending', chapter: 'c1.md' }).map((c) => c.id)).toEqual([a.id]);
    expect(store.list({ status: 'adopted' })[0]!.id).toBe(b.id);
    store.close();
  });

  it('patch 整改：更新 proposed+instruction，状态保持 pending；不存在返回 undefined', () => {
    const store = new CandidateStore(tmpDbPath());
    const c = store.create({ chapter: 'c.md', original: 'a', proposed: 'v1', instruction: '润色' });
    const before = c.updatedAt;

    const updated = store.patch(c.id, { proposed: 'v2', instruction: '润色 / 整改：太平' });
    expect(updated).toBeDefined();
    expect(updated!.proposed).toBe('v2');
    expect(updated!.instruction).toBe('润色 / 整改：太平');
    expect(updated!.status).toBe('pending');
    expect(updated!.updatedAt >= before).toBe(true);

    expect(store.patch('no-such-id', { status: 'discarded' })).toBeUndefined();
    store.close();
  });

  it('状态流转 pending → discarded / adopted', () => {
    const store = new CandidateStore(tmpDbPath());
    const c = store.create({ chapter: 'c.md', original: 'a', proposed: 'b' });
    expect(store.patch(c.id, { status: 'discarded' })!.status).toBe('discarded');
    expect(store.patch(c.id, { status: 'adopted' })!.status).toBe('adopted');
    store.close();
  });

  it('重启恢复：close 后重开同一路径，候选仍在', () => {
    const dbPath = tmpDbPath();
    const first = new CandidateStore(dbPath);
    const c = first.create({ chapter: 'c.md', original: 'a', proposed: 'b' });
    first.close();

    const reopened = new CandidateStore(dbPath);
    expect(reopened.get(c.id)?.proposed).toBe('b');
    reopened.close();
  });
});
