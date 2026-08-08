// 测试：SessionStore 的 CRUD、排序与重启恢复（网络不进单测，纯本地 sqlite）。
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/session-store.js';

function tmpDbPath(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'novel-store-test-')), 'sessions.sqlite');
}

describe('SessionStore', () => {
  it('会话 CRUD：创建、查询、按更新时间倒序', async () => {
    const store = new SessionStore(tmpDbPath());
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const a = store.createSession('会话甲');
      expect(store.getSession(a.id)?.title).toBe('会话甲');
      expect(store.getSession('不存在')).toBeUndefined();

      await sleep(5);
      const b = store.createSession('会话乙');
      let sessions = store.listSessions();
      expect(sessions[0]?.id).toBe(b.id); // b 最新
      expect(sessions[1]?.id).toBe(a.id);

      // 碰一下 a，a 回到最前
      await sleep(5);
      store.addMessage(a.id, { role: 'user', content: '你好' });
      sessions = store.listSessions();
      expect(sessions[0]?.id).toBe(a.id);
      expect(sessions[0]!.updatedAt >= sessions[1]!.updatedAt).toBe(true);
    } finally {
      store.close();
    }
  });

  it('消息按时间正序返回，tool_calls 往返一致', () => {
    const store = new SessionStore(tmpDbPath());
    try {
      const s = store.createSession('会话');
      store.addMessage(s.id, { role: 'user', content: '第一条' });
      store.addMessage(s.id, { role: 'assistant', content: '回复', toolCalls: [{ id: 'tc1', name: 'word_count', args: { relPath: 'a.md' } }] });
      store.addMessage(s.id, { role: 'user', content: '第二条' });
      const messages = store.listMessages(s.id);
      expect(messages.map((m) => m.content)).toEqual(['第一条', '回复', '第二条']);
      expect(messages[1]?.toolCalls).toEqual([{ id: 'tc1', name: 'word_count', args: { relPath: 'a.md' } }]);
    } finally {
      store.close();
    }
  });

  it('重启恢复：关闭后重开同一库文件，数据仍在', () => {
    const dbPath = tmpDbPath();
    let sessionId = '';
    {
      const store = new SessionStore(dbPath);
      const s = store.createSession('重启测试');
      sessionId = s.id;
      store.addMessage(s.id, { role: 'user', content: '内容' });
      store.close();
    }
    const reopened = new SessionStore(dbPath);
    try {
      expect(reopened.getSession(sessionId)?.title).toBe('重启测试');
      expect(reopened.listMessages(sessionId).map((m) => m.content)).toEqual(['内容']);
      expect(reopened.listSessions()).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it('向不存在的会话加消息会抛错（外键约束）', () => {
    const store = new SessionStore(tmpDbPath());
    try {
      expect(() => store.addMessage('不存在的会话', { role: 'user', content: 'x' })).toThrow();
    } finally {
      store.close();
    }
  });

  it('自动创建 .novel 目录', () => {
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'novel-store-test-')), 'a', 'b');
    const store = new SessionStore(path.join(dir, 'sessions.sqlite'));
    try {
      expect(store.listSessions()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
