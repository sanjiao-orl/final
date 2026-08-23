// 测试：POST /v1/quality/check 发布前质检（便宜模型路线）。
// 覆盖：确定性定位（quote 在正文 → line/paraLine 正确，含引号剥离与段首行换算；
// quote 不在正文 → located:false 且不出行号）；截断标记；空 findings；LLM 输出
// 非法 JSON / schema 不合规 → 502；read_chapter 工具缺失 → 502。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import { generateModel, startTestServer } from './helpers.js';

const REL = 'manuscript/第一卷·风起/第1章·少年.md';
const TITLE = '第1章·少年';
// 文件行号（1 起始）：1-4 frontmatter、5 空行、6 第一段、7 空行、8-9 第二段（两行）
const BODY_LINES = ['', '雾从山坳里漫上来。', '', '林渡握紧刀柄，指节发白。他听见远处传来一声铃响。', '刀出鞘的声音很轻。'];
const FRONTMATTER_RAW = `---\ntitle: ${TITLE}\nstatus: 草稿\n---\n`;
const BODY = BODY_LINES.join('\n');
const CONTENT = `${FRONTMATTER_RAW}${BODY}`;

function postCheck(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/quality/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function promptText(m: { content: unknown }): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content as { text?: string }[]).map((p) => p.text ?? '').join('');
}

/** domain 工具集 mock：只含 read_chapter。 */
function readChapterTool(overrides?: () => unknown): ToolSet {
  return {
    read_chapter: {
      description: '读章',
      execute: vi.fn(
        overrides ?? (() => ({ content: CONTENT, frontmatter: { title: TITLE }, frontmatterRaw: FRONTMATTER_RAW, body: BODY })),
      ),
    },
  } as unknown as ToolSet;
}

describe('POST /v1/quality/check 发布前质检', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-quality-test-'));
  });
  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('确定性定位：quote 在正文 → line 为文件行号、paraLine 为段首行号；带引号的 quote 剥引号后照常定位', async () => {
    const findings = [
      // 第二段第二行（文件行 9），所在段落段首是文件行 8
      { kind: 'typo', quote: '刀出鞘的声音很轻。', reason: '「轻」应为「清」的形近误用', suggestion: '改为「刀出鞘的声音很清脆」' },
      // LLM 用「」包住 quote：剥引号后应命中第一段（文件行 6，段首即自身）
      { kind: 'wording', quote: '「雾从山坳里漫上来。」', reason: '近距重复用词' },
    ];
    const model = generateModel([JSON.stringify({ elements: findings })]);
    const s = await startTestServer({ qualityCheck: { modelForTier: () => model, tools: readChapterTool() } });
    try {
      const res = await postCheck(s.baseUrl, s.token, { workDir, relPath: REL });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        chapterTitle: string;
        truncated?: boolean;
        findings: Array<{ kind: string; quote: string; located: boolean; line?: number; paraLine?: number }>;
      };
      expect(body.ok).toBe(true);
      expect(body.chapterTitle).toBe(TITLE);
      expect(body.truncated).toBeUndefined();
      expect(body.findings).toHaveLength(2);

      expect(body.findings[0]).toMatchObject({ kind: 'typo', located: true, line: 9, paraLine: 8 });
      expect(body.findings[1]).toMatchObject({ kind: 'wording', located: true, line: 6, paraLine: 6 });

      // LLM 输入含正文与章标题；system 是质检提示词
      const user = promptText(model.doGenerateCalls[0]!.prompt.find((m) => m.role === 'user')!);
      expect(user).toContain(`【章标题】${TITLE}`);
      expect(user).toContain('雾从山坳里漫上来');
      const system = promptText(model.doGenerateCalls[0]!.prompt.find((m) => m.role === 'system')!);
      expect(system).toContain('质检');
    } finally {
      await s.close();
    }
  });

  it('D7 跨行 quote 紧凑兜底：CRLF 文件 vs LF quote、段间空行差异 → located:true 行号正确', async () => {
    const crlf = (s: string): string => s.replace(/\n/g, '\r\n');
    const crlfContent = crlf(CONTENT);
    const tools = readChapterTool(() => ({
      content: crlfContent,
      frontmatter: { title: TITLE },
      frontmatterRaw: crlf(FRONTMATTER_RAW),
      body: crlf(BODY),
    }));
    const findings = [
      // 跨行 quote（LF）对 CRLF 文件：精确 indexOf 必未中 → 紧凑命中起始行 8（第二段段首即自身）
      { kind: 'typo', quote: '他听见远处传来一声铃响。\n刀出鞘的声音很轻。', reason: '跨行复述' },
      // 段间空行差异：正文两段隔一个空行（\r\n\r\n），quote 只用单个换行 → 紧凑命中行 6（第一段段首）
      { kind: 'wording', quote: '雾从山坳里漫上来。\n林渡握紧刀柄', reason: '段间空白差异' },
    ];
    const s = await startTestServer({ qualityCheck: { modelForTier: () => generateModel([JSON.stringify({ elements: findings })]), tools } });
    try {
      const res = await postCheck(s.baseUrl, s.token, { workDir, relPath: REL });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { findings: Array<{ located: boolean; line?: number; paraLine?: number }> };
      expect(body.findings[0]).toMatchObject({ located: true, line: 8, paraLine: 8 });
      expect(body.findings[1]).toMatchObject({ located: true, line: 6, paraLine: 6 });
    } finally {
      await s.close();
    }
  });

  it('quote 不在正文（LLM 复述而非逐字摘录）→ located:false，line/paraLine 不出现，不报错', async () => {
    const findings = [
      { kind: 'other', quote: '这句原文里根本没有', reason: '编造的引用也能优雅降级' },
      { kind: 'typo', quote: '   ', reason: '空白 quote 同样降级' },
    ];
    const s = await startTestServer({
      qualityCheck: { modelForTier: () => generateModel([JSON.stringify({ elements: findings })]), tools: readChapterTool() },
    });
    try {
      const res = await postCheck(s.baseUrl, s.token, { workDir, relPath: REL });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { findings: Array<{ located: boolean; line?: number; paraLine?: number }> };
      expect(body.findings).toHaveLength(2);
      for (const f of body.findings) {
        expect(f.located).toBe(false);
        expect('line' in f).toBe(false);
        expect('paraLine' in f).toBe(false);
      }
    } finally {
      await s.close();
    }
  });

  it('正文超 12000 字截断：响应标 truncated:true，prompt 含截断标注', async () => {
    const longBody = `\n${'雾'.repeat(13_000)}\n`;
    const model = generateModel([JSON.stringify({ elements: [] })]);
    const s = await startTestServer({
      qualityCheck: {
        modelForTier: () => model,
        tools: readChapterTool(() => ({ content: FRONTMATTER_RAW + longBody, frontmatter: { title: TITLE }, frontmatterRaw: FRONTMATTER_RAW, body: longBody })),
      },
    });
    try {
      const res = await postCheck(s.baseUrl, s.token, { workDir, relPath: REL });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { truncated?: boolean; findings: unknown[] };
      expect(body.truncated).toBe(true);
      expect(body.findings).toEqual([]);
      const user = promptText(model.doGenerateCalls[0]!.prompt.find((m) => m.role === 'user')!);
      expect(user).toContain('已截断');
    } finally {
      await s.close();
    }
  });

  it('没问题返回空数组 findings: []', async () => {
    const s = await startTestServer({
      qualityCheck: { modelForTier: () => generateModel([JSON.stringify({ elements: [] })]), tools: readChapterTool() },
    });
    try {
      const res = await postCheck(s.baseUrl, s.token, { workDir, relPath: REL });
      expect(res.status).toBe(200);
      expect((await res.json() as { findings: unknown[] }).findings).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it('模型输出非法 JSON / kind 出枚举 → 502 中文错误', async () => {
    for (const text of ['这不是 JSON', JSON.stringify({ elements: [{ kind: 'grammar', quote: 'q', reason: 'r' }] })]) {
      const s = await startTestServer({
        qualityCheck: { modelForTier: () => generateModel([text]), tools: readChapterTool() },
      });
      try {
        const res = await postCheck(s.baseUrl, s.token, { workDir, relPath: REL });
        expect(res.status).toBe(502);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('JSON');
      } finally {
        await s.close();
      }
    }
  });

  it('read_chapter 工具缺失 → 502 工具不可用；body 缺字段/workDir 不存在 → 400', async () => {
    const s1 = await startTestServer({
      qualityCheck: { modelForTier: () => generateModel(['x']), tools: {} as unknown as ToolSet },
    });
    try {
      const res = await postCheck(s1.baseUrl, s1.token, { workDir, relPath: REL });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('read_chapter 工具不可用');
    } finally {
      await s1.close();
    }

    const s2 = await startTestServer({ qualityCheck: { tools: readChapterTool() } });
    try {
      const missingRel = await postCheck(s2.baseUrl, s2.token, { workDir });
      expect(missingRel.status).toBe(400);
      const badDir = await postCheck(s2.baseUrl, s2.token, { workDir: 'C:/definitely/not/exist', relPath: REL });
      expect(badDir.status).toBe(400);
    } finally {
      await s2.close();
    }
  });
});
