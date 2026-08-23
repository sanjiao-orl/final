// 测试：HTTP 服务层——鉴权 401、/v1/health 200、CORS 预检、/v1/dev 免鉴权、会话路由、旧路径 404。
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../src/runtime.js';
import { readSse, startTestServer } from './helpers.js';

describe('core HTTP 服务', () => {
  it('GET /v1/llm → 200 配置形状', async () => {
    const s = await startTestServer();
    const previous = { ...process.env };
    try {
      Object.assign(process.env, {
        LLM_PRESET_TEST_BASE_URL: 'http://test/v1',
        LLM_PRESET_TEST_API_KEY: 'secret-key',
        LLM_PRESET_TEST_MODEL: 'test-model',
      });
      const res = await fetch(`${s.baseUrl}/v1/llm`, { headers: { Authorization: `Bearer ${s.token}` } });
      const body = (await res.json()) as { mode: string; effective: { writing: { model: string } }; presets: Array<{ apiKeyMasked: string }> };
      expect(res.status).toBe(200);
      expect(body.mode).toBe('presets');
      expect(typeof body.effective.writing.model).toBe('string');
      expect(body.effective.writing.model).not.toBe('');
      expect(body.presets.every((preset: { apiKeyMasked: string }) => !preset.apiKeyMasked.includes('secret-key'))).toBe(true);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      await s.close();
    }
  });

  it('GET /v1/health → 200 { ok, version, protocol, commit }', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.baseUrl}/v1/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; version: string; protocol: number; commit: string };
      expect(body.ok).toBe(true);
      expect(body.version).toBe('test');
      expect(body.protocol).toBe(PROTOCOL_VERSION);
      expect(typeof body.commit).toBe('string');
      expect(body.commit.length).toBeGreaterThan(0);
    } finally {
      await s.close();
    }
  });

  it('GET /v1/health 暴露 MCP 连通状态：toolsAvailable 注入与否三态', async () => {
    const readMcp = async (s: { baseUrl: string }): Promise<{ mcp?: { connected: boolean } }> => {
      const res = await fetch(`${s.baseUrl}/v1/health`);
      expect(res.status).toBe(200);
      return (await res.json()) as { mcp?: { connected: boolean } };
    };
    const down = await startTestServer({ toolsAvailable: () => false });
    try {
      expect((await readMcp(down)).mcp).toEqual({ connected: false });
    } finally {
      await down.close();
    }
    const up = await startTestServer({ toolsAvailable: () => true });
    try {
      expect((await readMcp(up)).mcp).toEqual({ connected: true });
    } finally {
      await up.close();
    }
    // 未装配 MCP：不下发字段（向后兼容，消费方按缺省视为不适用）
    const bare = await startTestServer();
    try {
      expect((await readMcp(bare)).mcp).toBeUndefined();
    } finally {
      await bare.close();
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

  it('Bearer token 校验三态：长度不等、等长相异均 401，正确 token 放行', async () => {
    const s = await startTestServer();
    try {
      // 长度不等（timingSafeEqual 前短路 false）
      expect((await fetch(`${s.baseUrl}/v1/llm`, { headers: { Authorization: `Bearer ${s.token}x` } })).status).toBe(401);
      expect((await fetch(`${s.baseUrl}/v1/llm`, { headers: { Authorization: `Bearer ${s.token.slice(0, -1)}` } })).status).toBe(401);
      // 等长相异
      const wrong = 'x'.repeat(s.token.length);
      expect((await fetch(`${s.baseUrl}/v1/llm`, { headers: { Authorization: `Bearer ${wrong}` } })).status).toBe(401);
      // 相等
      expect((await fetch(`${s.baseUrl}/v1/llm`, { headers: { Authorization: `Bearer ${s.token}` } })).status).toBe(200);
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

  it('CORS 预检 OPTIONS → 204：白名单 Origin 反射，其余不给 Allow-Origin', async () => {
    const s = await startTestServer();
    try {
      // 白名单 Origin（dev 浏览器）→ 反射 + Vary
      const ok = await fetch(`${s.baseUrl}/v1/chat`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:1420', 'Access-Control-Request-Method': 'POST' },
      });
      expect(ok.status).toBe(204);
      expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:1420');
      expect(ok.headers.get('vary')).toBe('Origin');
      expect(ok.headers.get('access-control-allow-headers')).toContain('Authorization');

      // 陌生 Origin → 不放行
      const evil = await fetch(`${s.baseUrl}/v1/chat`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' },
      });
      expect(evil.status).toBe(204);
      expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await s.close();
    }
  });

  it('CORS 白名单：http://localhost / http://127.0.0.1 任意端口与 Tauri Origin 反射 + Vary: Origin', async () => {
    const s = await startTestServer();
    try {
      const whitelisted = [
        'http://localhost:1420',
        'http://localhost',
        'http://127.0.0.1:5173',
        'http://tauri.localhost',
        'https://tauri.localhost',
        'tauri://localhost',
      ];
      for (const origin of whitelisted) {
        const res = await fetch(`${s.baseUrl}/v1/health`, { headers: { Origin: origin } });
        expect(res.status, origin).toBe(200);
        expect(res.headers.get('access-control-allow-origin'), origin).toBe(origin);
        expect(res.headers.get('vary'), origin).toBe('Origin');
      }
    } finally {
      await s.close();
    }
  });

  it('CORS 白名单外：陌生/前缀欺骗 Origin 一律不给 Allow-Origin，响应照常 200', async () => {
    const s = await startTestServer();
    try {
      for (const origin of ['http://evil.example', 'http://localhost.evil.com', 'tauri://localhost.evil.com']) {
        const res = await fetch(`${s.baseUrl}/v1/health`, { headers: { Origin: origin } });
        expect(res.status, origin).toBe(200);
        expect(res.headers.get('access-control-allow-origin'), origin).toBeNull();
        expect(res.headers.get('vary'), origin).toBeNull();
      }
    } finally {
      await s.close();
    }
  });

  it('CORS 无 Origin：正常 200 且不给 Allow-Origin（curl 等非浏览器客户端不受影响）', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.baseUrl}/v1/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('vary')).toBeNull();
    } finally {
      await s.close();
    }
  });

  it('请求体超限 → 413 JSON 响应，带 Connection: close（残留 body 不污染 keep-alive 下一请求，P3）', async () => {
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.baseUrl}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
        body: 'x'.repeat(1_000_001),
      });
      expect(res.status).toBe(413);
      expect(res.headers.get('content-type')).toContain('application/json');
      // 超限即在响应结束销毁 socket 关连接——断言 Connection: close 头（可测面：后续同连接不再复用）
      expect(res.headers.get('connection')).toBe('close');
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('请求体过大');
    } finally {
      await s.close();
    }
  });

  it('PATCH /v1/candidates 状态机：pending→adopted 合法 200；adopted→discarded 非法 400 透传中文原因（P2）', async () => {
    const s = await startTestServer();
    try {
      const auth = { Authorization: `Bearer ${s.token}` };
      const created = await fetch(`${s.baseUrl}/v1/candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ chapter: 'ch01.md', original: '旧文', proposed: '新文' }),
      });
      expect(created.status).toBe(200);
      const id = ((await created.json()) as { candidate: { id: string } }).candidate.id;

      // pending → adopted 合法（壳采纳路径）
      const ok = await fetch(`${s.baseUrl}/v1/candidates/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ status: 'adopted' }),
      });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { candidate: { status: string } }).candidate.status).toBe('adopted');

      // adopted → discarded 非法 → 400，错误映射为业务校验而非 500
      const bad = await fetch(`${s.baseUrl}/v1/candidates/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ status: 'discarded' }),
      });
      expect(bad.status).toBe(400);
      const bb = (await bad.json()) as { error: string };
      expect(bb.error).toContain('adopted');
      expect(bb.error).toContain('discarded');
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

  it('POST /v1/candidates：kind=append + original="" → 200 且候选 kind=append', async () => {
    const s = await startTestServer();
    try {
      const auth = { Authorization: `Bearer ${s.token}` };
      const res = await fetch(`${s.baseUrl}/v1/candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ chapter: 'ch01.md', proposed: '续写一段', kind: 'append', original: '' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { candidate: { kind: string; original: string } };
      expect(body.candidate.kind).toBe('append');
      expect(body.candidate.original).toBe('');
    } finally {
      await s.close();
    }
  });

  it('POST /v1/candidates：kind=replace + original="" → 400（含缺省 kind 同口径）', async () => {
    const s = await startTestServer();
    try {
      const auth = { Authorization: `Bearer ${s.token}` };
      // 显式 kind=replace 且 original 为空 → 400
      const explicit = await fetch(`${s.baseUrl}/v1/candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ chapter: 'ch01.md', proposed: 'x', kind: 'replace', original: '' }),
      });
      expect(explicit.status).toBe(400);
      // 缺省 kind（=replace）且 original 为空 → 同样 400（既有行为不变）
      const defaulted = await fetch(`${s.baseUrl}/v1/candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ chapter: 'ch01.md', proposed: 'x', original: '' }),
      });
      expect(defaulted.status).toBe(400);
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
