// 测试：/rewrite SSE 改写管道与 /candidates REST——mock 模型驱动的改写流、候选 CRUD、鉴权与校验。
import { describe, expect, it } from 'vitest';
import { readSse, startTestServer, stepModel, textResult } from './helpers.js';

function postRewrite(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/rewrite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function postCandidate(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/candidates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function patchCandidate(baseUrl: string, token: string, id: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/candidates/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('/rewrite SSE 改写管道', () => {
  it('text-delta 流 → done 带完整改写文本（trim 后），不落库', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['改后一段，', '更有画面。'])]) });
    try {
      const res = await postRewrite(s.baseUrl, s.token, { original: '原一段。', instruction: '更生动' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const events = await readSse(res);
      expect(events.map((e) => e.event)).toEqual(['text-delta', 'text-delta', 'done']);
      expect(events[2]?.data.text).toBe('改后一段，更有画面。');

      // 纯改写：不产生任何会话/消息
      expect(s.store.listSessions()).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it('请求体不合法 → 400 JSON 错误；缺鉴权 → 401', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['x'])]) });
    try {
      const bad = await postRewrite(s.baseUrl, s.token, { original: '', instruction: 'x' });
      expect(bad.status).toBe(400);

      const noAuth = await fetch(`${s.baseUrl}/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ original: 'a', instruction: '' }),
      });
      expect(noAuth.status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it('模型返回空白 → SSE error（模型返回了空改写结果）', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['  ', '\n'])]) });
    try {
      const res = await postRewrite(s.baseUrl, s.token, { original: '原。', instruction: '' });
      const events = await readSse(res);
      expect(events.at(-1)?.event).toBe('error');
      expect(String(events.at(-1)?.data.message)).toContain('空改写结果');
    } finally {
      await s.close();
    }
  });

  it('输出护栏：超长（>20k 字符）→ SSE error，不进 done', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['x'.repeat(20_001)])]) });
    try {
      const res = await postRewrite(s.baseUrl, s.token, { original: '原。', instruction: '' });
      const events = await readSse(res);
      expect(events.at(-1)?.event).toBe('error');
      expect(String(events.at(-1)?.data.message)).toContain('超长');
    } finally {
      await s.close();
    }
  });

  it('输出护栏：过短（不足原文 20%）→ SSE error，疑似未完成', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['短'])]) });
    try {
      const res = await postRewrite(s.baseUrl, s.token, { original: '原'.repeat(50), instruction: '' });
      const events = await readSse(res);
      expect(events.at(-1)?.event).toBe('error');
      expect(String(events.at(-1)?.data.message)).toContain('过短');
    } finally {
      await s.close();
    }
  });

  it('输出护栏：过长（超过原文 3 倍）→ SSE error，疑似注水', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['七字扩写文七字扩写文'])]) });
    try {
      const res = await postRewrite(s.baseUrl, s.token, { original: '原文', instruction: '' });
      const events = await readSse(res);
      expect(events.at(-1)?.event).toBe('error');
      expect(String(events.at(-1)?.data.message)).toContain('过长');
    } finally {
      await s.close();
    }
  });

  it('输出护栏：比例在 0.2~3 区间内正常出 done（流式文本仍实时转发）', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['改后文本。'])]) });
    try {
      const res = await postRewrite(s.baseUrl, s.token, { original: '原。', instruction: '' });
      const events = await readSse(res);
      expect(events.map((e) => e.event)).toEqual(['text-delta', 'done']);
      expect(events.at(-1)?.data.text).toBe('改后文本。');
    } finally {
      await s.close();
    }
  });
});

describe('/candidates REST', () => {
  it('OPTIONS 预检放行 PATCH（壳经浏览器跨源调 /candidates/:id 的硬依赖）', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['x'])]) });
    try {
      const res = await fetch(`${s.baseUrl}/candidates/any-id`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-methods')).toContain('PATCH');
    } finally {
      await s.close();
    }
  });

  it('POST 新建 → GET 过滤列表 → PATCH 状态/整改 → 404 与校验错误', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['x'])]) });
    try {
      // 新建两条：不同章
      const r1 = await postCandidate(s.baseUrl, s.token, {
        chapter: 'c1.md',
        original: '原文一',
        proposed: '建议一',
        instruction: '润色',
      });
      expect(r1.status).toBe(200);
      const c1 = ((await r1.json()) as { candidate: { id: string; status: string } }).candidate;
      expect(c1.status).toBe('pending');
      await postCandidate(s.baseUrl, s.token, { chapter: 'c2.md', original: '原文二', proposed: '建议二' });

      // 列表过滤
      const listRes = await fetch(`${s.baseUrl}/candidates?status=pending&chapter=c1.md`, {
        headers: { Authorization: `Bearer ${s.token}` },
      });
      const list = ((await listRes.json()) as { candidates: unknown[] }).candidates;
      expect(list).toHaveLength(1);

      // PATCH 整改（更新 proposed）
      const rectify = await patchCandidate(s.baseUrl, s.token, c1.id, { proposed: '建议一·整改版' });
      expect(rectify.status).toBe(200);
      expect(((await rectify.json()) as { candidate: { proposed: string } }).candidate.proposed).toBe('建议一·整改版');

      // PATCH 状态
      const adopt = await patchCandidate(s.baseUrl, s.token, c1.id, { status: 'adopted' });
      expect(adopt.status).toBe(200);

      // 空 PATCH / 非法状态 / 不存在
      expect((await patchCandidate(s.baseUrl, s.token, c1.id, {})).status).toBe(400);
      expect((await patchCandidate(s.baseUrl, s.token, c1.id, { status: 'weird' })).status).toBe(400);
      expect((await patchCandidate(s.baseUrl, s.token, 'no-such', { status: 'adopted' })).status).toBe(404);

      // status 过滤参数非法
      const badFilter = await fetch(`${s.baseUrl}/candidates?status=weird`, {
        headers: { Authorization: `Bearer ${s.token}` },
      });
      expect(badFilter.status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it('POST 校验：缺字段/空字符串 → 400', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['x'])]) });
    try {
      expect((await postCandidate(s.baseUrl, s.token, { chapter: 'c.md' })).status).toBe(400);
      expect(
        (await postCandidate(s.baseUrl, s.token, { chapter: 'c.md', original: '', proposed: 'b' })).status
      ).toBe(400);
    } finally {
      await s.close();
    }
  });
});
