// 测试：POST /v1/review —— 贵档冷读审阅（一次性 JSON，非 SSE）。
// 覆盖：ledger_slice 组装提示词 → main 档模型 → 解析 findings；围栏/前后废话容错；非法 JSON → 502；
// MCP 重连中/工具缺失 → 503；body 缺字段 → 400。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import { startTestServer, stepModel, textResult } from './helpers.js';

function postReview(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** 模拟 domain 工具集：ledger_slice 返回 { slice }（本地工具直接返回对象，不走 MCP content 包装）。
 * 可附 issue_append mock（入参 { workDir, findings }，返回 { appended, ids, path }），用于闭环落盘断言。 */
function ledgerSliceTools(
  slice: string,
  execute = vi.fn(async () => ({ slice, injectedChapters: ['manuscript/卷一/第1章.md'] })),
  issueAppendExecute?: (input: unknown) => Promise<unknown>,
): ToolSet {
  const tools: Record<string, unknown> = {
    ledger_slice: { description: '组装冷读输入', execute },
  };
  if (issueAppendExecute) tools.issue_append = { description: '追加审阅问题到 issues.md', execute: issueAppendExecute };
  return tools as unknown as ToolSet;
}

const GOOD_BODY = { workDir: 'C:/works/demo', chapterRelPath: 'manuscript/卷一/第1章.md' };
const GOOD_FINDINGS = [
  { severity: 'BLOCKER', quote: '他死了。', why: '与账本时钟冲突', suggestion: '改为未死或更新账本' },
  { severity: 'MODERATE', quote: '少年握拳。', why: '动作描写可更具体' },
];
// 含可选 category 与四级 severity 的审阅结果（验证 category/MINOR 透传 + chapter 注入）。
const CATEGORIZED_FINDINGS = [
  { severity: 'BLOCKER', category: 'CONT', quote: '他死了。', why: '与账本时钟冲突', suggestion: '改为未死或更新账本' },
  { severity: 'MINOR', quote: '少年握拳。', why: '动作描写可更具体' },
];

describe('POST /v1/review 贵档审阅', () => {
  // 无 issue_append mock 的既有用例会走降级 warn 路径，静音保持输出干净（落盘断言见下方新用例）。
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('findings 非空时经 issue_append 确定性落盘：chapter 注入请求章相对路径，category/MINOR 透传，响应带 persisted', async () => {
    const issueAppendExecute = vi.fn(async () => ({
      appended: 2,
      ids: ['editorial_notes/issues.md:12', 'editorial_notes/issues.md:13'],
      path: 'editorial_notes/issues.md',
    }));
    const s = await startTestServer({
      modelForTier: () => stepModel([textResult([JSON.stringify(CATEGORIZED_FINDINGS)])]),
      tools: ledgerSliceTools('slice', undefined, issueAppendExecute),
    });
    try {
      const res = await postReview(s.baseUrl, s.token, GOOD_BODY);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { findings: unknown[]; persisted?: { appended: number; ids: string[] } };
      expect(body.findings).toEqual(CATEGORIZED_FINDINGS);
      expect(body.persisted).toEqual({ appended: 2, ids: ['editorial_notes/issues.md:12', 'editorial_notes/issues.md:13'] });

      expect(issueAppendExecute).toHaveBeenCalledWith(
        {
          workDir: 'C:/works/demo',
          findings: CATEGORIZED_FINDINGS.map((f) => ({ ...f, chapter: 'manuscript/卷一/第1章.md' })),
        },
        expect.objectContaining({ toolCallId: 'review-issue-append' }),
      );
    } finally {
      await s.close();
    }
  });

  it('issue_append 抛错时降级：响应仍 200、findings 正常返回，不带 persisted', async () => {
    const issueAppendExecute = vi.fn(async () => {
      throw new Error('mock 落盘失败');
    });
    const s = await startTestServer({
      modelForTier: () => stepModel([textResult([JSON.stringify(GOOD_FINDINGS)])]),
      tools: ledgerSliceTools('slice', undefined, issueAppendExecute),
    });
    try {
      const res = await postReview(s.baseUrl, s.token, GOOD_BODY);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { findings: unknown[]; persisted?: unknown };
      expect(body.findings).toEqual(GOOD_FINDINGS);
      expect(body.persisted).toBeUndefined();
    } finally {
      await s.close();
    }
  });

  it('tools 无 issue_append（无 MCP 连接）时降级：findings 正常返回，不带 persisted', async () => {
    const s = await startTestServer({
      modelForTier: () => stepModel([textResult([JSON.stringify(GOOD_FINDINGS)])]),
      tools: ledgerSliceTools('slice'), // 只含 ledger_slice，无 issue_append
    });
    try {
      const res = await postReview(s.baseUrl, s.token, GOOD_BODY);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { findings: unknown[]; persisted?: unknown };
      expect(body.findings).toEqual(GOOD_FINDINGS);
      expect(body.persisted).toBeUndefined();
    } finally {
      await s.close();
    }
  });
});
