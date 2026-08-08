// 测试：HTTP 服务层——鉴权 401、/health 200、CORS 预检、/dev 免鉴权、会话路由。
import { describe, expect, it } from 'vitest';
import { startTestServer } from './helpers.js';

describe('core HTTP 服务', () => {
  it('GET /health → 200 { ok, version }', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, version: 'test' });
    } finally {
      await s.close();
    }
  });

  it('除 /health 与 /dev 外，无 token 一律 401', async () => {
    const s = await startTestServer();
    try {
      const cases: Array<[string, string]> = [
        ['GET', '/sessions'],
        ['GET', '/sessions/某个id'],
        ['POST', '/chat'],
      ];
      for (const [method, path] of cases) {
        const res = await fetch(`${s.baseUrl}${path}`, { method });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    } finally {
      await s.close();
    }
  });

  it('/dev 免鉴权返回内嵌联调页，且带 /chat 与 token 占位', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.baseUrl}/dev`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('novel core /dev');
      expect(html).toContain('/chat');
      expect(html).toContain(s.token);
    } finally {
      await s.close();
    }
  });

  it('CORS 预检 OPTIONS → 204 且带放开头', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.baseUrl}/chat`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:1420', 'Access-Control-Request-Method': 'POST' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    } finally {
      await s.close();
    }
  });

  it('带 token 访问 /sessions 与 /sessions/:id', async () => {
    const s = await startTestServer();
    try {
      const auth = { Authorization: `Bearer ${s.token}` };

      let res = await fetch(`${s.baseUrl}/sessions`, { headers: auth });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { sessions: unknown[] }).sessions).toEqual([]);

      // 造一个会话 + 一条消息
      const session = s.store.createSession('标题');
      s.store.addMessage(session.id, { role: 'user', content: 'hi' });

      res = await fetch(`${s.baseUrl}/sessions`, { headers: auth });
      const list = (await res.json()) as { sessions: Array<{ id: string; title: string }> };
      expect(list.sessions).toHaveLength(1);
      expect(list.sessions[0]?.title).toBe('标题');

      res = await fetch(`${s.baseUrl}/sessions/${session.id}`, { headers: auth });
      expect(res.status).toBe(200);
      const detail = (await res.json()) as { messages: Array<{ content: string }> };
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages[0]?.content).toBe('hi');

      // 不存在的会话 → 404
      res = await fetch(`${s.baseUrl}/sessions/不存在`, { headers: auth });
      expect(res.status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it('POST /chat 无 token 401，有 token 且模型报错时返回 SSE error 事件', async () => {
    const s = await startTestServer({
      modelForTier: () => {
        throw new Error('模型工厂被调用即失败');
      },
    });
    try {
      const auth = { Authorization: `Bearer ${s.token}` };
      let res = await fetch(`${s.baseUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(res.status).toBe(401);

      res = await fetch(`${s.baseUrl}/chat`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('event: error');
    } finally {
      await s.close();
    }
  });
});
