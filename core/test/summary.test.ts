// 测试：POST /v1/summary/generate 章摘要生成（便宜档）+ chat 数据层「前章摘要」注入。
// 覆盖：read_chapter → generateText(Output.object) → word_count → write_chapter_summary →
// read_chapter_summaries 回读的完整链路（调用次序与参数）；LLM 输出非法 JSON / schema 不合规 → 502；
// 正文超限截断标注；工具缺失/失败 → 502；chat 系统提示含/不含前章摘要节（含机检行省略口径）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import { generateModel, startTestServer, stepModel, textResult, type SseEvent } from './helpers.js';

const REL = 'manuscript/第一卷·风起/第3章·雾夜.md';
const TITLE = '第3章·雾夜';
const BODY = '\n林渡推开客栈的窗，雾气漫进来。窗外有人低声提及「青崖山」。他握紧了刀柄。\n';
const FRONTMATTER_RAW = `---\ntitle: ${TITLE}\nstatus: 草稿\n---\n`;
const CONTENT = `${FRONTMATTER_RAW}${BODY}`;
const GOOD_OUTPUT = {
  summary: '林渡夜宿客栈时听到窗外有人低声提及「青崖山」，情绪由平静转向警觉不安。',
  tension: 7,
  sceneType: '悬念',
};
const GENERATED_AT = '2026-02-01T08:00:00.000Z';

function postSummary(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/summary/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function promptText(m: { content: unknown }): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content as { text?: string }[]).map((p) => p.text ?? '').join('');
}

/** domain 工具集 mock：read_chapter / word_count / write_chapter_summary / read_chapter_summaries，各自可覆盖 execute。 */
function summaryTools(overrides: {
  readChapter?: () => Promise<unknown> | unknown;
  wordCount?: () => Promise<unknown> | unknown;
  writeSummary?: () => Promise<unknown> | unknown;
  readSummaries?: () => Promise<unknown> | unknown;
} = {}): ToolSet {
  const tools = {
    read_chapter: {
      description: '读章',
      execute: vi.fn(overrides.readChapter ?? (() => ({ content: CONTENT, frontmatter: { title: TITLE }, frontmatterRaw: FRONTMATTER_RAW, body: BODY }))),
    },
    word_count: {
      description: '数字数',
      execute: vi.fn(overrides.wordCount ?? (() => ({ total: 30 }))),
    },
    write_chapter_summary: {
      description: '写摘要缓存',
      execute: vi.fn(overrides.writeSummary ?? (() => ({ ok: true, frozen: false }))),
    },
    read_chapter_summaries: {
      description: '读摘要缓存',
      execute: vi.fn(
        overrides.readSummaries ??
          (() => ({
            summaries: [{ relPath: REL, summary: GOOD_OUTPUT.summary, tension: 7, sceneType: '悬念', wordCount: 30, generatedAt: GENERATED_AT }],
          })),
      ),
    },
  };
  return tools as unknown as ToolSet;
}

/** 建一个真实存在的临时 workDir（端点侧 normalizeWorkDir 要求目录存在）。 */
function makeWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'core-summary-test-'));
}

describe('POST /v1/summary/generate 章摘要生成', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = makeWorkDir();
  });
  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('正常链路：read→generate→word_count→write→回读 次序与参数正确，200 返回 record', async () => {
    const tools = summaryTools();
    const model = generateModel([JSON.stringify(GOOD_OUTPUT)]);
    const s = await startTestServer({ summary: { modelForTier: () => model, tools } });
    try {
      const res = await postSummary(s.baseUrl, s.token, { workDir, relPath: REL });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        frozen: false,
        record: { relPath: REL, summary: GOOD_OUTPUT.summary, tension: 7, sceneType: '悬念', wordCount: 30, generatedAt: GENERATED_AT },
      });

      // 调用次序：read_chapter → word_count → write_chapter_summary → read_chapter_summaries
      const t = tools as unknown as Record<string, { execute: ReturnType<typeof vi.fn> }>;
      const [readOrder] = t.read_chapter!.execute.mock.invocationCallOrder;
      const [wcOrder] = t.word_count!.execute.mock.invocationCallOrder;
      const [writeOrder] = t.write_chapter_summary!.execute.mock.invocationCallOrder;
      const [readBackOrder] = t.read_chapter_summaries!.execute.mock.invocationCallOrder;
      expect(readOrder!).toBeLessThan(wcOrder!);
      expect(wcOrder!).toBeLessThan(writeOrder!);
      expect(writeOrder!).toBeLessThan(readBackOrder!);

      // 各工具入参
      expect(t.read_chapter!.execute).toHaveBeenCalledWith(
        { workDir, relPath: REL },
        expect.objectContaining({ toolCallId: 'summary-read-chapter' }),
      );
      expect(t.word_count!.execute).toHaveBeenCalledWith(
        { workDir, relPath: REL },
        expect.objectContaining({ toolCallId: 'summary-word-count' }),
      );
      expect(t.write_chapter_summary!.execute).toHaveBeenCalledWith(
        { workDir, relPath: REL, summary: GOOD_OUTPUT.summary, tension: 7, sceneType: '悬念', wordCount: 30 },
        expect.objectContaining({ toolCallId: 'summary-write' }),
      );
      expect(t.read_chapter_summaries!.execute).toHaveBeenCalledWith(
        { workDir, relPath: REL },
        expect.objectContaining({ toolCallId: 'summary-read-back' }),
      );

      // LLM 输入：system=summary 提示词；prompt 含章标题与正文
      const prompt = model.doGenerateCalls[0]!.prompt;
      const system = prompt.find((m) => m.role === 'system');
      expect(promptText(system!)).toContain('章节摘要员');
      const user = promptText(prompt.find((m) => m.role === 'user')!);
      expect(user).toContain(`【章标题】${TITLE}`);
      expect(user).toContain('【正文】');
      expect(user).toContain('青崖山');
    } finally {
      await s.close();
    }
  });

  it('模型输出非法 JSON → 502，中文错误', async () => {
    const s = await startTestServer({
      summary: { modelForTier: () => generateModel(['这不是 JSON']), tools: summaryTools() },
    });
    try {
      const res = await postSummary(s.baseUrl, s.token, { workDir, relPath: REL });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('JSON');
    } finally {
      await s.close();
    }
  });

  it('模型输出 schema 不合规（tension 越界 / sceneType 出枚举）→ 502', async () => {
    for (const bad of [
      { ...GOOD_OUTPUT, tension: 11 },
      { ...GOOD_OUTPUT, sceneType: '悬疑' },
      { ...GOOD_OUTPUT, tension: 3.5 },
    ]) {
      const s = await startTestServer({
        summary: { modelForTier: () => generateModel([JSON.stringify(bad)]), tools: summaryTools() },
      });
      try {
        const res = await postSummary(s.baseUrl, s.token, { workDir, relPath: REL });
        expect(res.status).toBe(502);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain('JSON');
      } finally {
        await s.close();
      }
    }
  });

  it('正文超 12000 字截断：prompt 含截断标注（截断不影响落盘链路）', async () => {
    const longBody = `\n${'雾'.repeat(13_000)}\n`;
    const tools = summaryTools({ readChapter: () => ({ content: FRONTMATTER_RAW + longBody, frontmatter: { title: TITLE }, frontmatterRaw: FRONTMATTER_RAW, body: longBody }) });
    const model = generateModel([JSON.stringify(GOOD_OUTPUT)]);
    const s = await startTestServer({ summary: { modelForTier: () => model, tools } });
    try {
      const res = await postSummary(s.baseUrl, s.token, { workDir, relPath: REL });
      expect(res.status).toBe(200);
      const user = promptText(model.doGenerateCalls[0]!.prompt.find((m) => m.role === 'user')!);
      expect(user).toContain('已截断');
      expect(user.length).toBeLessThan(13_000);
    } finally {
      await s.close();
    }
  });

  it('tools 缺 read_chapter → 502 工具不可用；word_count 返回无效 → 502', async () => {
    const s1 = await startTestServer({
      summary: { modelForTier: () => generateModel([JSON.stringify(GOOD_OUTPUT)]), tools: {} as unknown as ToolSet },
    });
    try {
      const res = await postSummary(s1.baseUrl, s1.token, { workDir, relPath: REL });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('read_chapter 工具不可用');
    } finally {
      await s1.close();
    }

    const s2 = await startTestServer({
      summary: {
        modelForTier: () => generateModel([JSON.stringify(GOOD_OUTPUT)]),
        tools: summaryTools({ wordCount: () => ({}) }), // 无 total 字段
      },
    });
    try {
      const res = await postSummary(s2.baseUrl, s2.token, { workDir, relPath: REL });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('word_count');
    } finally {
      await s2.close();
    }
  });

  it('write_chapter_summary 执行失败 → 502 带中文原因', async () => {
    const s = await startTestServer({
      summary: {
        modelForTier: () => generateModel([JSON.stringify(GOOD_OUTPUT)]),
        tools: summaryTools({ writeSummary: () => { throw new Error('章不在当前章序内'); } }),
      },
    });
    try {
      const res = await postSummary(s.baseUrl, s.token, { workDir, relPath: REL });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('章不在当前章序内');
    } finally {
      await s.close();
    }
  });

  it('body 缺字段 → 400；workDir 不存在 → 400', async () => {
    const s = await startTestServer({ summary: { modelForTier: () => generateModel([]), tools: summaryTools() } });
    try {
      const missingRel = await postSummary(s.baseUrl, s.token, { workDir });
      expect(missingRel.status).toBe(400);
      const badDir = await postSummary(s.baseUrl, s.token, { workDir: 'C:/definitely/not/exist', relPath: REL });
      expect(badDir.status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it('frozen=true 透传（重建场景 domain 冻结机检字段）', async () => {
    const s = await startTestServer({
      summary: {
        modelForTier: () => generateModel([JSON.stringify(GOOD_OUTPUT)]),
        tools: summaryTools({ writeSummary: () => ({ ok: true, frozen: true }) }),
      },
    });
    try {
      const res = await postSummary(s.baseUrl, s.token, { workDir, relPath: REL });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { frozen: boolean };
      expect(body.frozen).toBe(true);
    } finally {
      await s.close();
    }
  });
});

// ---------- chat 数据层「前章摘要」注入 ----------

function postChat(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** 前章摘要记录（全字段）。 */
const PREV_RECORD = {
  relPath: 'manuscript/第一卷·风起/第2章·旧事.md',
  summary: '林渡在旧宅翻出一封残信，得知父亲当年失踪前曾去过青崖山。',
  tension: 5,
  sceneType: '悬念',
  wordCount: 800,
  generatedAt: GENERATED_AT,
};

function prevSummaryTool(result: unknown): ToolSet {
  return {
    read_chapter_summaries: { description: '读摘要缓存', execute: vi.fn(async () => result) },
  } as unknown as ToolSet;
}

describe('chat 数据层前章摘要注入', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = makeWorkDir();
  });
  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('有前章记录 → 系统提示注入「## 前章摘要」节 + 机检行；execute 入参带 before=当前章', async () => {
    const tools = prevSummaryTool({ summaries: [PREV_RECORD] });
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model, tools });
    try {
      const res = await postChat(s.baseUrl, s.token, {
        text: '接下来怎么写',
        workDir,
        chapter: REL,
      });
      expect(res.status).toBe(200);
      await readSseAll(res);
      const sys = model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system')!;
      const sysText = promptText(sys);
      expect(sysText).toContain('## 前章摘要（最近 1 章）');
      expect(sysText).toContain(`### ${PREV_RECORD.relPath}`);
      expect(sysText).toContain(PREV_RECORD.summary);
      expect(sysText).toContain('[机检] tension: 5 · sceneType: 悬念 · 字数: 800');
      // T11：滚动多章——入参带 limit=3（domain 侧缺省仍为 1）
      expect(tools.read_chapter_summaries!.execute).toHaveBeenCalledWith(
        { workDir, before: REL, limit: 3 },
        expect.objectContaining({ toolCallId: 'chat-prev-summary' }),
      );
    } finally {
      await s.close();
    }
  });

  it('无 chapter / 工具缺失 / summaries 空 → 零注入（不阻断聊天）', async () => {
    // 无 chapter
    const emptyExecute = vi.fn(async () => ({ summaries: [PREV_RECORD] }));
    const s1 = await startTestServer({
      modelForTier: () => stepModel([textResult(['好'])]),
      tools: { read_chapter_summaries: { description: '', execute: emptyExecute } } as unknown as ToolSet,
    });
    try {
      const res = await postChat(s1.baseUrl, s1.token, { text: '整体基调', workDir });
      await readSseAll(res);
      expect(emptyExecute).not.toHaveBeenCalled();
    } finally {
      await s1.close();
    }

    // 工具缺失
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model2 = stepModel([textResult(['好'])]);
    const s2 = await startTestServer({ modelForTier: () => model2, tools: {} });
    try {
      const res = await postChat(s2.baseUrl, s2.token, { text: '下一章', workDir, chapter: REL });
      const events = await readSseAll(res);
      expect(events.at(-1)!.event).toBe('done');
      const sys2 = model2.doStreamCalls[0]!.prompt.find((m) => m.role === 'system')!;
      expect(promptText(sys2)).not.toContain('## 前章摘要');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await s2.close();
    }

    // summaries 为空数组（首章 / 前章无摘要）
    const model3 = stepModel([textResult(['好'])]);
    const s3 = await startTestServer({ modelForTier: () => model3, tools: prevSummaryTool({ summaries: [] }) });
    try {
      const res = await postChat(s3.baseUrl, s3.token, { text: '下一章', workDir, chapter: REL });
      const events = await readSseAll(res);
      expect(events.at(-1)!.event).toBe('done');
      const sys3 = model3.doStreamCalls[0]!.prompt.find((m) => m.role === 'system')!;
      expect(promptText(sys3)).not.toContain('## 前章摘要');
    } finally {
      await s3.close();
    }
  });

  it('机检字段部分缺省 → [机检] 行只列在场字段；全缺则整行不出', async () => {
    // 只剩 tension
    const partial: ToolSet = prevSummaryTool({
      summaries: [{ relPath: PREV_RECORD.relPath, summary: PREV_RECORD.summary, tension: 6, generatedAt: GENERATED_AT }],
    });
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model, tools: partial });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '继续', workDir, chapter: REL });
      await readSseAll(res);
      const sysText = promptText(model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system')!);
      expect(sysText).toContain('[机检] tension: 6');
      expect(sysText).not.toContain('sceneType');
      expect(sysText).not.toContain('字数:');
    } finally {
      await s.close();
    }

    // 全缺
    const bare = prevSummaryTool({
      summaries: [{ relPath: PREV_RECORD.relPath, summary: PREV_RECORD.summary, generatedAt: GENERATED_AT }],
    });
    const model2 = stepModel([textResult(['好'])]);
    const s2 = await startTestServer({ modelForTier: () => model2, tools: bare });
    try {
      const res = await postChat(s2.baseUrl, s2.token, { text: '继续', workDir, chapter: REL });
      await readSseAll(res);
      const sysText = promptText(model2.doStreamCalls[0]!.prompt.find((m) => m.role === 'system')!);
      expect(sysText).toContain(`### ${PREV_RECORD.relPath}`);
      expect(sysText).not.toContain('[机检]');
    } finally {
      await s2.close();
    }
  });

  it('摘要散文超配额逐条截断并加省略标注（T11：预算语义改为整节总预算 4000）', async () => {
    const longSummary = '长'.repeat(3000);
    const tools = prevSummaryTool({
      summaries: [
        { ...PREV_RECORD, summary: longSummary },
        { relPath: 'manuscript/第一卷·风起/第1章·下山.md', summary: '少年下山。', tension: 3, generatedAt: GENERATED_AT },
      ],
    });
    const model = stepModel([textResult(['好'])]);
    const s = await startTestServer({ modelForTier: () => model, tools });
    try {
      const res = await postChat(s.baseUrl, s.token, { text: '继续', workDir, chapter: REL });
      await readSseAll(res);
      const sysText = promptText(model.doStreamCalls[0]!.prompt.find((m) => m.role === 'system')!);
      // 每条配额 = floor(4000/2) = 2000，长散文逐条截断标注；短的那条原样保留
      expect(sysText).toContain('前章摘要超 2000 字符，已截断');
      expect(sysText).not.toContain('长'.repeat(2500));
      expect(sysText.indexOf('[机检]')).toBeGreaterThan(sysText.indexOf('已截断')); // 截断标注后仍有机检行
    } finally {
      await s.close();
    }
  });

  /** 读完整 SSE 并解析事件（本地版：避免与 chat.test.ts 循环依赖）。 */
  async function readSseAll(response: Response): Promise<SseEvent[]> {
    const events: SseEvent[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (t.startsWith('event:')) event = t.slice(6).trim();
          else if (t.startsWith('data:')) dataLines.push(t.slice(5).trim());
        }
        if (dataLines.length > 0) events.push({ event, data: JSON.parse(dataLines.join('\n')) });
      }
    }
    return events;
  }
});
