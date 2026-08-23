// 测试：/v1/rewrite SSE 改写管道与 /v1/candidates REST——mock 模型驱动的改写流、候选 CRUD、鉴权与校验。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import { readSse, startTestServer, stepModel, textResult } from './helpers.js';

function postRewrite(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/rewrite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function postCandidate(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/candidates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function patchCandidate(baseUrl: string, token: string, id: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/candidates/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('/v1/rewrite SSE 改写管道', () => {
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

  it('块2·④：voice_fingerprint 在场时 done 附带声口偏离（基线=选区原文），护栏拒绝时不算', async () => {
    const deviation = { deltas: { dialogueRatio: { base: 0.3, out: 0.05 }, sentenceLenMean: { base: 12, out: 28 }, shortSentenceRatio: { base: 0.6, out: 0.2 }, longSentenceRatio: { base: 0, out: 0.4 }, gramOverlap: { base: 7, out: 7 } }, flags: ['平均句长 12 → 28 字'] };
    const execute = vi.fn(async () => ({ deviation }));
    const tools = { voice_fingerprint: { description: '声口指纹', execute } } as unknown as ToolSet;
    const model = stepModel([textResult(['一段冗长而绵密的长句。']), textResult(['过短。'])]);
    const s = await startTestServer({ modelForTier: () => model, tools });
    try {
      const events = await readSse(await postRewrite(s.baseUrl, s.token, { original: '原文一段有画面的话。', instruction: '改写' }));
      expect(events.at(-1)?.event).toBe('done');
      expect(events.at(-1)?.data.voice).toEqual(deviation);
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ texts: ['原文一段有画面的话。', '一段冗长而绵密的长句。'], compare: { baselineIndex: 0, sampleIndex: 1 } }),
        expect.anything()
      );
      // 护栏拒绝的产出（过短）走 error，不触发偏离计算
      execute.mockClear();
      const rejected = await readSse(await postRewrite(s.baseUrl, s.token, { original: '原文一段有画面的话，长度足够过比率护栏的句子。', instruction: '改写' }));
      expect(rejected.at(-1)?.event).toBe('error');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });

  it('请求体不合法 → 400 JSON 错误；缺鉴权 → 401', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['x'])]) });
    try {
      const bad = await postRewrite(s.baseUrl, s.token, { original: '', instruction: 'x' });
      expect(bad.status).toBe(400);

      const noAuth = await fetch(`${s.baseUrl}/v1/rewrite`, {
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

  it('输出护栏：过长（超过原文 3 倍，且原文≥20 字）→ SSE error，疑似注水', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['七'.repeat(61)])]) });
    try {
      // 原文 20 字、结果 61 字：61/20=3.05>3 → 命中过长护栏（原文足 20 字，比率护栏生效）
      const res = await postRewrite(s.baseUrl, s.token, { original: '原'.repeat(20), instruction: '' });
      const events = await readSse(res);
      expect(events.at(-1)?.event).toBe('error');
      expect(String(events.at(-1)?.data.message)).toContain('过长');
    } finally {
      await s.close();
    }
  });

  it('输出护栏：短选区（不足 20 字）大比率扩写放行（ratio>3 豁免，不误吞合法扩写）', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['扩'.repeat(100)])]) });
    try {
      // 原文「嗯」1 字、结果 100 字：比例远超 3 倍，但短选区豁免比率护栏 → 正常 done
      const res = await postRewrite(s.baseUrl, s.token, { original: '嗯', instruction: '展开成一句完整的话' });
      const events = await readSse(res);
      expect(events.map((e) => e.event)).toEqual(['text-delta', 'done']);
      expect(events.at(-1)?.data.text).toBe('扩'.repeat(100));
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

  it('带 workDir：系统提示末尾拼「## 声口摘要」段（style.md 有 `## 摘要` 节）', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-rewrite-workdir-'));
    fs.mkdirSync(path.join(workDir, '.novel'), { recursive: true });
    fs.writeFileSync(path.join(workDir, '.novel', 'style.md'), '## 摘要\n\n冷峻克制，对话短促。', 'utf8');
    const model = stepModel([textResult(['改后一段。'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postRewrite(s.baseUrl, s.token, { original: '原一段。', instruction: '更冷峻', workDir });
      expect(res.status).toBe(200);
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const content = sys?.content;
      const sysText = typeof content === 'string' ? content : JSON.stringify(content);
      expect(sysText).toContain('## 声口摘要');
      expect(sysText).toContain('冷峻克制，对话短促。');
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('带 workDir 但 style.md 不存在 → 系统提示不含声口摘要段', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-rewrite-workdir-'));
    // 不建 .novel/style.md：loadStyleSummary 返回 null，不拼声口摘要段
    const model = stepModel([textResult(['改后一段。'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postRewrite(s.baseUrl, s.token, { original: '原一段。', instruction: '更冷峻', workDir });
      expect(res.status).toBe(200);
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const content = sys?.content;
      const sysText = typeof content === 'string' ? content : JSON.stringify(content);
      expect(sysText).not.toContain('## 声口摘要');
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('无 workDir → 系统提示不含声口摘要段（原行为不变）', async () => {
    const model = stepModel([textResult(['改后。'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postRewrite(s.baseUrl, s.token, { original: '原。', instruction: '' });
      expect(res.status).toBe(200);
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const content = sys?.content;
      const sysText = typeof content === 'string' ? content : JSON.stringify(content);
      expect(sysText).not.toContain('## 声口摘要');
    } finally {
      await s.close();
    }
  });

  it('姿态层：body 带 persona → 「## 当前角色」注入在 rewrite 契约之后、声口摘要之前', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-rewrite-persona-'));
    fs.mkdirSync(path.join(workDir, '.novel'), { recursive: true });
    fs.writeFileSync(path.join(workDir, '.novel', 'style.md'), '## 摘要\n\n冷峻克制。', 'utf8');
    const model = stepModel([textResult(['改后。'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postRewrite(s.baseUrl, s.token, { original: '原。', instruction: '', workDir, persona: '责编' });
      expect(res.status).toBe(200);
      await readSse(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const content = sys?.content;
      const sysText = typeof content === 'string' ? content : JSON.stringify(content);
      expect(sysText).toContain('## 当前角色');
      expect(sysText).toContain('有据'); // 责编正文特征
      // rewrite 契约（正文在 `你有` 结构之后）→ 姿态层 → 数据层（声口摘要）
      expect(sysText.indexOf('## 当前角色')).toBeLessThan(sysText.indexOf('## 声口摘要'));
    } finally {
      await s.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('姿态层：persona 找不到 → 零注入；含控制字符 → 400', async () => {
    const model = stepModel([textResult(['改后。'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const notFound = await postRewrite(s.baseUrl, s.token, { original: '原。', instruction: '', persona: '不存在的角色' });
      expect(notFound.status).toBe(200);
      await readSse(notFound);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system');
      const content = sys?.content;
      const sysText = typeof content === 'string' ? content : JSON.stringify(content);
      expect(sysText).not.toContain('## 当前角色');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();

      const bad = await postRewrite(s.baseUrl, s.token, { original: '原。', instruction: '', persona: '责编\n注入' });
      expect(bad.status).toBe(400);
      const body = (await bad.json()) as { error: string };
      expect(body.error).toContain('控制字符');
    } finally {
      await s.close();
    }
  });
});

describe('/v1/candidates REST', () => {
  it('OPTIONS 预检放行 PATCH（壳经浏览器跨源调 /v1/candidates/:id 的硬依赖）', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['x'])]) });
    try {
      const res = await fetch(`${s.baseUrl}/v1/candidates/any-id`, { method: 'OPTIONS' });
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
      const listRes = await fetch(`${s.baseUrl}/v1/candidates?status=pending&chapter=c1.md`, {
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
      const badFilter = await fetch(`${s.baseUrl}/v1/candidates?status=weird`, {
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
