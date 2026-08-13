// 测试：POST /v1/tools/:name —— core 对 domain MCP 工具的 HTTP 代理（壳的数据面）。
// 覆盖：JSON 文本结果解析回对象、structuredContent 优先、isError → 502、工具缺失/未注入 → 404、非 JSON 文本原样返回。
import { describe, expect, it } from 'vitest';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { startTestServer } from './helpers.js';

function fakeTools(): ToolSet {
  const wrap = (execute: (args: unknown) => unknown) => ({
    execute: async (args: unknown) => execute(args),
  });
  return {
    echo_json: wrap((args) => ({
      content: [{ type: 'text', text: JSON.stringify({ got: args }) }],
    })),
    echo_structured: wrap(() => ({
      structuredContent: { via: 'structured' },
      content: [{ type: 'text', text: '{"via":"text"}' }],
    })),
    echo_plain: wrap(() => ({ content: [{ type: 'text', text: '不是 JSON' }] })),
    failing: wrap(() => ({ isError: true, content: [{ type: 'text', text: '磁盘只读' }] })),
    no_execute: { description: '无 execute 的工具' },
  } as unknown as ToolSet;
}

async function postTool(baseUrl: string, token: string, name: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/tools/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  });
}

describe('POST /v1/tools/:name 工具代理', () => {
  it('JSON 文本结果解析回对象返回，参数原样透传', async () => {
    const s = await startTestServer({ tools: fakeTools() });
    try {
      const res = await postTool(s.baseUrl, s.token, 'echo_json', { workDir: '/x', n: 1 });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ got: { workDir: '/x', n: 1 } });
    } finally {
      await s.close();
    }
  });

  it('structuredContent 优先于 text', async () => {
    const s = await startTestServer({ tools: fakeTools() });
    try {
      const res = await postTool(s.baseUrl, s.token, 'echo_structured', {});
      expect(await res.json()).toEqual({ via: 'structured' });
    } finally {
      await s.close();
    }
  });

  it('非 JSON 文本结果原样返回', async () => {
    const s = await startTestServer({ tools: fakeTools() });
    try {
      const res = await postTool(s.baseUrl, s.token, 'echo_plain', {});
      expect(await res.json()).toBe('不是 JSON');
    } finally {
      await s.close();
    }
  });

  it('isError 结果 → 502 且带工具侧错误文本', async () => {
    const s = await startTestServer({ tools: fakeTools() });
    try {
      const res = await postTool(s.baseUrl, s.token, 'failing', {});
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('磁盘只读');
    } finally {
      await s.close();
    }
  });

  it('MCP 重连中（toolsAvailable=false）→ 503 而非 404 或执行工具', async () => {
    const s = await startTestServer({ tools: fakeTools(), toolsAvailable: () => false });
    try {
      const res = await postTool(s.baseUrl, s.token, 'echo_json', {});
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('重连中');
    } finally {
      await s.close();
    }
  });

  it('工具不存在、无 execute、未注入 tools 三种情况都 404', async () => {
    const s = await startTestServer({ tools: fakeTools() });
    try {
      expect((await postTool(s.baseUrl, s.token, '不存在', {})).status).toBe(404);
      expect((await postTool(s.baseUrl, s.token, 'no_execute', {})).status).toBe(404);
    } finally {
      await s.close();
    }
    const bare = await startTestServer();
    try {
      expect((await postTool(bare.baseUrl, bare.token, 'echo_json', {})).status).toBe(404);
    } finally {
      await bare.close();
    }
  });

  it('带 inputSchema 的工具：坏入参 → 400，好入参照常执行', async () => {
    const tools: ToolSet = {
      count_words: tool({
        description: '统计字数',
        inputSchema: z.object({ relPath: z.string().min(1) }),
        execute: async ({ relPath }) => ({ relPath, count: relPath.length }),
      }),
    };
    const s = await startTestServer({ tools });
    try {
      const bad = await postTool(s.baseUrl, s.token, 'count_words', { relPath: 123 });
      expect(bad.status).toBe(400);
      const badBody = (await bad.json()) as { error: string };
      expect(badBody.error).toContain('请求体不合法');

      const good = await postTool(s.baseUrl, s.token, 'count_words', { relPath: 'ch01.md' });
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({ relPath: 'ch01.md', count: 7 });
    } finally {
      await s.close();
    }
  });

  it('MCP JSON Schema 入参也经代理前校验', async () => {
    const tools: ToolSet = {
      add_one: tool({
        description: '数字加一',
        inputSchema: jsonSchema<{ n: number }>({
          type: 'object',
          properties: { n: { type: 'number' } },
          required: ['n'],
        }),
        execute: async ({ n }) => ({ n: n + 1 }),
      }),
    };
    const s = await startTestServer({ tools });
    try {
      const bad = await postTool(s.baseUrl, s.token, 'add_one', { n: '不是数字' });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toContain('请求体不合法');

      const good = await postTool(s.baseUrl, s.token, 'add_one', { n: 1 });
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({ n: 2 });
    } finally {
      await s.close();
    }
  });

  it('execute 抛错 → 500，且原始错误消息不泄露（脱敏为稳定占位）', async () => {
    const s = await startTestServer({
      tools: {
        boom: { execute: async () => { throw new Error('越界路径 C:\\secret'); } },
      } as unknown as ToolSet,
    });
    try {
      const res = await postTool(s.baseUrl, s.token, 'boom', {});
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).not.toContain('C:\\secret');
      expect(body.error).toContain('内部错误');
    } finally {
      await s.close();
    }
  });
});
