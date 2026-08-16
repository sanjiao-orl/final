// 测试：HTTP 服务层——鉴权 401、/v1/health 200、CORS 预检、/v1/dev 免鉴权、会话路由、旧路径 404。
import { describe, expect, it } from 'vitest';
import { readSse, startTestServer } from './helpers.js';

describe('core HTTP 服务', () => {
  it('GET /v1/health → 200 { ok, version, protocol, commit }', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.baseUrl}/v1/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; version: string; protocol: number; commit: string };
      expect(body.ok).toBe(true);
      expect(body.version).toBe('test');
      expect(body.protocol).toBe(1);
      expect(typeof body.commit).toBe('string');
      expect(body.commit.length).toBeGreaterThan(0);
    } finally {
      await s.close();
    }
  });

  it('协议已版本化：无 /v1/ 前缀的旧路径一律 404（带迁移提示）', async () => {
    const s = await startTestServer();
    try {
      const cases: Array<[string, string]> = [
        ['GET', '/health'],
        ['GET', '/dev'],
        ['GET', '/sessions'],
        ['POST', '/chat'],
        ['POST', '/rewrite'],
        ['POST', '/candidates'],
        ['POST', '/tools/list_structure'],
      ];
      for (const [method, path] of cases) {
        const res = await fetch(`${s.baseUrl}${path}`, { method });
        expect(res.status, `${method} ${path}`).toBe(404);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('/v1/');
      }
    } finally {
      await s.close();
    }
  });

  it('除 /v1/health 与 /v1/dev 外，无 token 一律 401', async () => {
    const s = await startTestServer();
    try {
      const cases: Array<[string, string]> = [
        ['GET', '/v1/sessions'],
        ['GET', '/v1/sessions/某个id'],
        ['POST', '/v1/chat'],
        ['POST', '/v1/tools/list_structure'],
      ];
      for (const [method, path] of cases) {
        const res = await fetch(`${s.baseUrl}${path}`, { method });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    } finally {
      await s.close();
    }
  });

  it('/v1/dev 免鉴权返回内嵌联调页，不内嵌 token 且提供 token 输入框', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.baseUrl}/v1/dev`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('novel core /v1/dev');
      expect(html).toContain('/v1/chat');
      expect(html).not.toContain(s.token);
      // 页面改为让开发者粘贴 token 并 localStorage 记忆，不再自动内嵌
      expect(html).toContain('id="token"');
      expect(html).toContain("localStorage.getItem('devToken')");
      // 回归：新会话 sessionId 为 null 时不得下发该字段（服务端 optional 不接受 null）
      expect(html).not.toContain('JSON.stringify({ sessionId: state.sessionId, text: text })');
      expect(html).toContain('state.sessionId ? { sessionId: state.sessionId, text: text } : { text: text }');
    } finally {
      await s.close();
    }
  });

  it('devEnabled=false 时 GET /v1/dev 回 404（与其他 404 同形），/v1/health 仍免鉴权 200', async () => {
    const s = await startTestServer({ devEnabled: false });
    try {
      const dev = await fetch(`${s.baseUrl}/v1/dev`);
      expect(dev.status).toBe(404);
      const body = (await dev.json()) as { error: string };
      expect(body.error).toContain('未找到: GET /v1/dev');
      // /v1/health 不受门禁影响
      const health = await fetch(`${s.baseUrl}/v1/health`);
      expect(health.status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('CORS 预检 OPTIONS → 204 且带放开头', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.baseUrl}/v1/chat`, {
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

  it('请求体超限 → 413 JSON 响应，连接不重置', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.baseUrl}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
        body: 'x'.repeat(1_000_001),
      });
      expect(res.status).toBe(413);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('请求体过大');
    } finally {
      await s.close();
    }
  });

  it('带 token 访问 /v1/sessions 与 /v1/sessions/:id', async () => {
    const s = await startTestServer();
    try {
      const auth = { Authorization: `Bearer ${s.token}` };

      let res = await fetch(`${s.baseUrl}/v1/sessions`, { headers: auth });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { sessions: unknown[] }).sessions).toEqual([]);

      // 造一个会话 + 一条消息
      const session = s.store.createSession('标题');
      s.store.addMessage(session.id, { role: 'user', content: 'hi' });

      res = await fetch(`${s.baseUrl}/v1/sessions`, { headers: auth });
      const list = (await res.json()) as { sessions: Array<{ id: string; title: string }> };
      expect(list.sessions).toHaveLength(1);
      expect(list.sessions[0]?.title).toBe('标题');

      res = await fetch(`${s.baseUrl}/v1/sessions/${session.id}`, { headers: auth });
      expect(res.status).toBe(200);
      const detail = (await res.json()) as { messages: Array<{ content: string }> };
      expect(detail.messages).toHaveLength(1);
      expect(detail.messages[0]?.content).toBe('hi');

      // 不存在的会话 → 404
      res = await fetch(`${s.baseUrl}/v1/sessions/不存在`, { headers: auth });
      expect(res.status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it('POST /v1/chat 无 token 401，有 token 且模型报错时返回 SSE error 事件', async () => {
    const s = await startTestServer({
      modelForTier: () => {
        throw new Error('模型工厂被调用即失败');
      },
    });
    try {
      const auth = { Authorization: `Bearer ${s.token}` };
      let res = await fetch(`${s.baseUrl}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(res.status).toBe(401);

      res = await fetch(`${s.baseUrl}/v1/chat`, {
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

  it('内部错误脱敏：非 HttpError 的原始错误（含路径）不透传进 500 响应体', async () => {
    const secretPath = 'C:\\Users\\secret\\works\\novel\\sessions.sqlite';
    const s = await startTestServer({
      toolsAvailable: () => {
        throw new Error(`读取失败: ${secretPath}`);
      },
    });
    try {
      const res = await fetch(`${s.baseUrl}/v1/tools/word_count`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).not.toContain(secretPath);
      expect(body.error).toContain('内部错误');
    } finally {
      await s.close();
    }
  });

  it('SSE 内部错误脱敏：模型抛原始 Error（含路径）时 error 帧消息不含路径', async () => {
    const secretPath = 'C:\\Users\\secret\\works\\novel\\sessions.sqlite';
    const s = await startTestServer({
      modelForTier: () => {
        throw new Error(`LLM 调用失败: ${secretPath}`);
      },
    });
    try {
      const res = await fetch(`${s.baseUrl}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(res.status).toBe(200);
      const events = await readSse(res);
      expect(events.at(-1)?.event).toBe('error');
      expect(String(events.at(-1)?.data.message)).not.toContain(secretPath);
      expect(String(events.at(-1)?.data.message)).toContain('内部错误');
    } finally {
      await s.close();
    }
  });

  it('非法 URL 编码的路径段 → 400（decodeURIComponent 的 URIError 不落入 500）', async () => {
    const s = await startTestServer();
    try {
      const auth = { Authorization: `Bearer ${s.token}` };
      // %E0%A4%A 是不完整的 UTF-8 序列，decodeURIComponent 会抛 URIError
      const res = await fetch(`${s.baseUrl}/v1/tools/%E0%A4%A`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: '{}',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('URL 编码');

      const patch = await fetch(`${s.baseUrl}/v1/candidates/%E0%A4%A`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: '{}',
      });
      expect(patch.status).toBe(400);
    } finally {
      await s.close();
    }
  });
});
