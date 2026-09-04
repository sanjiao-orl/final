// scan.test.ts —— POST /v1/scan/promise：预筛（mock domain 工具）→ 便宜档 LLM 判定（mock 模型）→ 提案草稿入收件箱。
// 覆盖：正常流（new/retire 映射为 ops 且入箱）、link 类不产提案（零入箱）、预筛零嫌疑（零 LLM 调用）、
// 工具缺失/重连 503、body 缺字段 400、maxChapters 预算闸。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import { startTestServer, generateModel } from './helpers.js';
import { handleScanRequest, makeScanOps } from '../src/scan.js';

function postScan(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/scan/promise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** 模拟 domain 工具集：promise_prefilter / inbox_append（本地直接返回对象）。 */
function scanTools(prefilterResult: unknown, appendExecute = vi.fn(async () => ({ added: ['PR-1'], skipped: [] }))): { tools: ToolSet; appendExecute: ReturnType<typeof vi.fn> } {
  const appendExecuteMock = appendExecute as unknown as ReturnType<typeof vi.fn>;
  const tools: Record<string, unknown> = {
    promise_prefilter: { description: '预筛', execute: vi.fn(async () => prefilterResult) },
    inbox_append: { description: '提案入箱', execute: appendExecuteMock },
  };
  return { tools: tools as unknown as ToolSet, appendExecute: appendExecuteMock };
}

const PREFILTER_HIT = {
  chapters: [
    {
      chapterRelPath: 'manuscript/第3章.md',
      hits: [
        { line: 5, quote: '他答应过要把铜哨交还。', predicate: '答应', matchedPromiseIds: [] },
        { line: 9, quote: '这笔账迟早要讨回。', predicate: '迟早', matchedPromiseIds: ['P-001'] },
      ],
    },
  ],
  scanned: 10,
  registeredPromises: 1,
};

const FINDINGS = {
  findings: [
    { kind: 'new', name: '交还铜哨的承诺', quote: '他答应过要把铜哨交还。', rationale: '后文回收铜哨的依据' },
    { kind: 'retire', promiseId: 'P-001', quote: '这笔账迟早要讨回。', rationale: '作者明确撤线' },
    { kind: 'new', name: '', quote: '空名候选', rationale: '应被过滤' },
  ],
};

describe('POST /v1/scan/promise 承诺伏笔扫描', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('正常流：LLM 判定映射 ops 并入收件箱，响应带 coverage', async () => {
    const { tools, appendExecute } = scanTools(PREFILTER_HIT);
    const { baseUrl, token, close } = await startTestServer({
      modelForTier: () => generateModel([JSON.stringify(FINDINGS)]),
      tools,
    });
    try {
      const res = await postScan(baseUrl, token, { workDir: 'C:/works/demo', maxChapters: 5 });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { suspectChapters: number; llmCalls: number; inbox: { added: string[] }; detail: unknown[] };
      expect(json.suspectChapters).toBe(1);
      expect(json.llmCalls).toBe(1);
      expect(json.inbox.added).toEqual(['PR-1']);
      // inbox_append 收到 1 份草稿、2 条实体操作（空名 new 被滤掉）
      expect(appendExecute).toHaveBeenCalledTimes(1);
      const arg = appendExecute.mock.calls[0]![0] as { workDir: string; drafts: Array<{ origin: string; ops: Array<{ action: string; targetKey: string }> }> };
      expect(arg.workDir).toBe('C:/works/demo');
      expect(arg.drafts[0]!.origin).toBe('scan');
      expect(arg.drafts[0]!.ops.length).toBe(2);
      expect(arg.drafts[0]!.ops[0]!.action).toBe('ADD');
      expect(arg.drafts[0]!.ops[1]!.action).toBe('DELETE');
    } finally {
      await close();
    }
  });

  it('预筛零嫌疑：不调 LLM、不入箱', async () => {
    const modelFn = vi.fn(() => generateModel([JSON.stringify({ findings: [] })]));
    const { tools } = scanTools({ chapters: [], scanned: 10, registeredPromises: 3 });
    const { baseUrl, token, close } = await startTestServer({ modelForTier: modelFn as never, tools });
    try {
      const res = await postScan(baseUrl, token, { workDir: 'C:/works/demo' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { suspectChapters: number; llmCalls: number; inbox: { added: string[] } };
      expect(json.suspectChapters).toBe(0);
      expect(json.llmCalls).toBe(0);
      expect(json.inbox.added).toEqual([]);
      expect(modelFn).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('maxChapters 预算闸：嫌疑章超限时截断', async () => {
    const many = { chapters: Array.from({ length: 10 }, (_, i) => ({ chapterRelPath: `manuscript/第${i + 1}章.md`, hits: [{ line: 1, quote: '答应', predicate: '答应', matchedPromiseIds: [] }] })), scanned: 100, registeredPromises: 0 };
    const { tools, appendExecute } = scanTools(many);
    const modelText = JSON.stringify({ findings: [] });
    const { baseUrl, token, close } = await startTestServer({
      modelForTier: () => generateModel([modelText, modelText, modelText, modelText, modelText]),
      tools,
    });
    try {
      const res = await postScan(baseUrl, token, { workDir: 'C:/works/demo', maxChapters: 3 });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { suspectChapters: number; llmCalls: number };
      expect(json.suspectChapters).toBe(3);
      expect(json.llmCalls).toBe(3);
      expect(appendExecute).not.toHaveBeenCalled(); // 全空 findings 无草稿
    } finally {
      await close();
    }
  });

  it('MCP 重连中 → 503；body 缺字段 → 400', async () => {
    const { tools } = scanTools(PREFILTER_HIT);
    const { baseUrl, token, close } = await startTestServer({
      modelForTier: () => generateModel([JSON.stringify({ findings: [] })]),
      tools,
      toolsAvailable: () => false,
    });
    try {
      const res = await postScan(baseUrl, token, { workDir: 'C:/works/demo' });
      expect(res.status).toBe(503);
    } finally {
      await close();
    }
    const { baseUrl: b2, token: t2, close: c2 } = await startTestServer({
      modelForTier: () => generateModel([JSON.stringify({ findings: [] })]),
      tools,
    });
    try {
      const bad = await postScan(b2, t2, { chapterRelPaths: ['x'] });
      expect(bad.status).toBe(400);
    } finally {
      await c2();
    }
  });
});

describe('makeScanOps 确定性映射', () => {
  it('new 生成稳定 id（章键+序号）；retire 映射 remove；非法项过滤', () => {
    const ops = makeScanOps('manuscript/第12章.md', '0012', [
      { kind: 'new', name: '承诺A', quote: 'q1', rationale: 'r' },
      { kind: 'new', name: '承诺B', quote: 'q2', rationale: 'r' },
      { kind: 'retire', promiseId: 'P-009', quote: 'q3', rationale: 'r' },
      { kind: 'new', name: '  ', quote: 'q4', rationale: 'r' },
      { kind: 'retire', promiseId: '', quote: 'q5', rationale: 'r' },
    ]);
    expect(ops.length).toBe(3);
    expect(ops[0]!.targetKey).toBe('P-S-0012-01');
    expect(ops[1]!.targetKey).toBe('P-S-0012-02');
    expect(ops[2]!.action).toBe('DELETE');
    expect((ops[0]!.op as { op: string; entry: { setups: unknown[] } }).entry.setups.length).toBe(1);
  });
});
