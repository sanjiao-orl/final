// 测试：POST /v1/review —— 贵档冷读审阅（一次性 JSON，非 SSE）。
// 覆盖：ledger_slice 组装提示词 → main 档模型 → 解析 findings；围栏/前后废话容错；非法 JSON → 502；
// MCP 重连中/工具缺失 → 503；body 缺字段 → 400。
import { describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import { startTestServer, stepModel, textResult } from './helpers.js';

function postReview(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** 模拟 domain ledger_slice 工具：返回 { slice }（本地工具直接返回对象，不走 MCP content 包装）。 */
function ledgerSliceTools(slice: string, execute = vi.fn(async () => ({ slice, injectedChapters: ['manuscript/卷一/第1章.md'] }))): ToolSet {
  return {
    ledger_slice: { description: '组装冷读输入', execute },
  } as unknown as ToolSet;
}

const GOOD_BODY = { workDir: 'C:/works/demo', chapterRelPath: 'manuscript/卷一/第1章.md' };
const GOOD_FINDINGS = [
  { severity: 'BLOCKER', quote: '他死了。', why: '与账本时钟冲突', suggestion: '改为未死或更新账本' },
  { severity: 'MODERATE', quote: '少年握拳。', why: '动作描写可更具体' },
];

describe('POST /v1/review 贵档审阅', () => {
  it('正常返回解析后的 findings，并只把 ledger_slice 的 slice 作为用户提示词', async () => {
    const slice = '# 冷读输入（单章 + 账本切片）\n\n## 本章正文\n正文内容';
    const execute = vi.fn(async () => ({ slice, injectedChapters: ['manuscript/卷一/第1章.md'] }));
    const model = stepModel([textResult([JSON.stringify(GOOD_FINDINGS)])]);
    const s = await startTestServer({ modelForTier: () => model, tools: ledgerSliceTools(slice, execute) });
    try {
      const res = await postReview(s.baseUrl, s.token, GOOD_BODY);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ findings: GOOD_FINDINGS });

      expect(execute).toHaveBeenCalledWith(
        { workDir: 'C:/works/demo', chapterRelPath: 'manuscript/卷一/第1章.md' },
        expect.objectContaining({ toolCallId: 'review-ledger-slice' }),
      );

      // 模型收到的用户提示词就是 ledger_slice 返回的 slice（core 不额外注入文件内容）。
      const prompt = model.doStreamCalls[0]!.prompt;
      const user = prompt.find((m) => m.role === 'user');
      expect(JSON.stringify(user?.content)).toContain('单章 + 账本切片');
      const system = prompt.find((m) => m.role === 'system');
      expect(JSON.stringify(system?.content)).toContain('JSON 数组');
    } finally {
      await s.close();
    }
  });

  it('模型输出带 ```json 围栏与前后废话时能提取 JSON 数组', async () => {
    const raw = '好的，审阅结果如下：\n```json\n' + JSON.stringify(GOOD_FINDINGS) + '\n```\n以上，请查收。';
    const s = await startTestServer({
      modelForTier: () => stepModel([textResult([raw])]),
      tools: ledgerSliceTools('slice'),
    });
    try {
      const res = await postReview(s.baseUrl, s.token, GOOD_BODY);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ findings: GOOD_FINDINGS });
    } finally {
      await s.close();
    }
  });

  it('空 findings 合法返回 []', async () => {
    const s = await startTestServer({
      modelForTier: () => stepModel([textResult(['[]'])]),
      tools: ledgerSliceTools('slice'),
    });
    try {
      const res = await postReview(s.baseUrl, s.token, GOOD_BODY);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ findings: [] });
    } finally {
      await s.close();
    }
  });

  it('模型输出非法 JSON → 502，中文错误不泄露内部细节', async () => {
    const s = await startTestServer({
      modelForTier: () => stepModel([textResult(['这不是 JSON'])]),
      tools: ledgerSliceTools('slice'),
    });
    try {
      const res = await postReview(s.baseUrl, s.token, GOOD_BODY);
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('JSON');
    } finally {
      await s.close();
    }
  });

  it('模型输出 JSON 但 schema 不合法（severity 取值错）→ 502', async () => {
    const s = await startTestServer({
      modelForTier: () => stepModel([textResult(['[{"severity":"FATAL","quote":"q","why":"w"}]'])]),
      tools: ledgerSliceTools('slice'),
    });
    try {
      const res = await postReview(s.baseUrl, s.token, GOOD_BODY);
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('JSON');
    } finally {
      await s.close();
    }
  });

  it('MCP 重连中（toolsAvailable=false）→ 503', async () => {
    const s = await startTestServer({
      modelForTier: () => stepModel([textResult(['[]'])]),
      tools: ledgerSliceTools('slice'),
      toolsAvailable: () => false,
    });
    try {
      const res = await postReview(s.baseUrl, s.token, GOOD_BODY);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('重连中');
    } finally {
      await s.close();
    }
  });

  it('ledger_slice 工具缺失 → 503', async () => {
    const s = await startTestServer({
      modelForTier: () => stepModel([textResult(['[]'])]),
      tools: {},
    });
    try {
      const res = await postReview(s.baseUrl, s.token, GOOD_BODY);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('工具不可用');
    } finally {
      await s.close();
    }
  });

  it('body 缺字段 → 400', async () => {
    const s = await startTestServer({ tools: ledgerSliceTools('slice') });
    try {
      const missingWorkDir = await postReview(s.baseUrl, s.token, { chapterRelPath: 'manuscript/卷一/第1章.md' });
      expect(missingWorkDir.status).toBe(400);
      const missingChapter = await postReview(s.baseUrl, s.token, { workDir: 'C:/works/demo' });
      expect(missingChapter.status).toBe(400);
    } finally {
      await s.close();
    }
  });
});
