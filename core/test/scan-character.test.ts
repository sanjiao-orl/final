// scan-character.test.ts —— POST /v1/scan/character：确定性预筛（mock domain 工具）→ 提案映射 → 入收件箱（零 LLM）。
// 覆盖：超域疑似→ADD 草稿、写法变体→NOOP 草稿、maxCandidates 预算闸（超域疑似优先）、零候选不入箱、400/503。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import { startTestServer } from './helpers.js';

function postScanCharacter(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/scan/character`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function charTools(prefilterResult: unknown, appendExecute = vi.fn(async () => ({ added: ['PR-1', 'PR-2', 'PR-3'], skipped: [], outcomes: [{ id: 'PR-1', added: true }, { id: 'PR-2', added: true }, { id: 'PR-3', added: true }] }))): { tools: ToolSet; appendExecute: ReturnType<typeof vi.fn> } {
  const tools: Record<string, unknown> = {
    character_prefilter: { description: '角色预筛', execute: vi.fn(async () => prefilterResult) },
    inbox_append: { description: '提案入箱', execute: appendExecute },
  };
  return { tools: tools as unknown as ToolSet, appendExecute };
}

const PREFILTER = {
  scanned: 5,
  mentions: [{ name: '克莱恩', count: 30 }],
  unknownCandidates: [
    { name: '齐夏', count: 9, firstChapter: 'manuscript/第1章.md' },
    { name: '夜莺', count: 4, firstChapter: 'manuscript/第2章.md' },
  ],
  variantSuspects: [{ variant: '克菜恩', likely: '克莱恩', count: 2 }],
};

describe('POST /v1/scan/character 角色维确定性补账', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('正常流：超域疑似→ADD、变体→NOOP，全部入箱', async () => {
    const { tools, appendExecute } = charTools(PREFILTER);
    const { baseUrl, token, close } = await startTestServer({ tools });
    try {
      const res = await postScanCharacter(baseUrl, token, { workDir: 'C:/works/demo' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { scannedChapters: number; unknownCandidates: number; variantSuspects: number; inbox: { added: string[] }; detail: Array<{ proposalId: string }> };
      expect(json.scannedChapters).toBe(5);
      expect(json.unknownCandidates).toBe(2);
      expect(json.variantSuspects).toBe(1);
      expect(json.inbox.added.length).toBe(3);
      const arg = appendExecute.mock.calls[0]![0] as { workDir: string; drafts: Array<{ origin: string; ops: Array<{ action: string; targetKey: string; op: { op: string; entry: { name: string } } }> }> };
      expect(arg.drafts.length).toBe(3);
      expect(arg.drafts[0]!.ops[0]!.action).toBe('ADD');
      expect(arg.drafts[0]!.ops[0]!.op.entry.name).toBe('齐夏');
      expect(arg.drafts[2]!.ops[0]!.action).toBe('NOOP');
      // 抑制键粒度=targetKey=具体变体（likely 名作键会让一次误报吞掉同名未来所有新变体）
      expect(arg.drafts[2]!.ops[0]!.targetKey).toBe('克菜恩');
      // detail 按 outcomes 同序回填真实提案 id（与 scan.ts 同纪律）
      expect(json.detail).toEqual([{ proposalId: 'PR-1' }, { proposalId: 'PR-2' }, { proposalId: 'PR-3' }]);
    } finally {
      await close();
    }
  });

  it('maxCandidates 预算闸：超域疑似优先占额', async () => {
    const { tools, appendExecute } = charTools(PREFILTER);
    const { baseUrl, token, close } = await startTestServer({ tools });
    try {
      const res = await postScanCharacter(baseUrl, token, { workDir: 'C:/works/demo', maxCandidates: 1 });
      expect(res.status).toBe(200);
      const arg = appendExecute.mock.calls[0]![0] as { drafts: unknown[] };
      expect(arg.drafts.length).toBe(1); // 只有超域疑似第一条，变体被挤掉
    } finally {
      await close();
    }
  });

  it('零候选/零变体：不调 inbox_append', async () => {
    const { tools, appendExecute } = charTools({ scanned: 3, mentions: [], unknownCandidates: [], variantSuspects: [] });
    const { baseUrl, token, close } = await startTestServer({ tools });
    try {
      const res = await postScanCharacter(baseUrl, token, { workDir: 'C:/works/demo' });
      expect(res.status).toBe(200);
      expect(appendExecute).not.toHaveBeenCalled();
      const json = (await res.json()) as { inbox: { added: string[] } };
      expect(json.inbox.added).toEqual([]);
    } finally {
      await close();
    }
  });

  it('工具缺失 → 503；body 缺字段 → 400', async () => {
    const { tools } = charTools(PREFILTER);
    const { baseUrl, token, close } = await startTestServer({ tools, toolsAvailable: () => false });
    try {
      const res = await postScanCharacter(baseUrl, token, { workDir: 'C:/works/demo' });
      expect(res.status).toBe(503);
    } finally {
      await close();
    }
    const { baseUrl: b2, token: t2, close: c2 } = await startTestServer({ tools });
    try {
      const bad = await postScanCharacter(b2, t2, { chapterRelPaths: ['x'] });
      expect(bad.status).toBe(400);
    } finally {
      await c2();
    }
  });
});
