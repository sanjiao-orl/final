// 测试：/v1/continue 触发式续写 SSE——请求校验、prompt 拼装、声口注入与事件序列。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import { readSse, startTestServer, stepModel, textResult } from './helpers.js';

function postContinue(baseUrl: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/continue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('/v1/continue SSE 触发式续写', () => {
  it('缺 context/空 context/非字符串 → 400，超长 → 413 并关闭连接', async () => {
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['续写。'])]) });
    try {
      expect((await postContinue(s.baseUrl, s.token, {})).status).toBe(400);
      expect((await postContinue(s.baseUrl, s.token, { context: '' })).status).toBe(400);
      expect((await postContinue(s.baseUrl, s.token, { context: 1 })).status).toBe(400);
      const tooLong = await postContinue(s.baseUrl, s.token, { context: '长'.repeat(8_001) });
      expect(tooLong.status).toBe(413);
      expect(tooLong.headers.get('connection')).toContain('close');
    } finally {
      await s.close();
    }
  });

  it('含 instruction 时拼入 prompt，事件为 text-delta → done 且 done 是完整文本', async () => {
    const model = stepModel([textResult(['夜色更深，', '门外传来脚步。'])]);
    const s = await startTestServer({ modelForTier: () => model });
    try {
      const res = await postContinue(s.baseUrl, s.token, { context: '他回头看向长廊。', instruction: '往紧张方向写' });
      const events = await readSse(res);
      expect(events.map((e) => e.event)).toEqual(['text-delta', 'text-delta', 'done']);
      expect(events.map((e) => e.data.text)).toEqual(['夜色更深，', '门外传来脚步。', '夜色更深，门外传来脚步。']);
    } finally {
      await s.close();
    }
  });

  it('workDir 有声口摘要时注入，缺失时静默降级', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-continue-workdir-'));
    fs.mkdirSync(path.join(workDir, '.novel'));
    fs.writeFileSync(path.join(workDir, '.novel', 'style.md'), '## 摘要\n\n冷峻，短句。\n\n## 其他\n忽略。', 'utf8');
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['续上。']), textResult(['降级。'])]) });
    try {
      const withStyle = await postContinue(s.baseUrl, s.token, { context: '他抬眼。', workDir });
      expect((await readSse(withStyle)).at(-1)?.event).toBe('done');
      const withoutStyle = await postContinue(s.baseUrl, s.token, { context: '他抬眼。', workDir: path.join(workDir, 'missing') });
      expect(withoutStyle.status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it('块2·④：voice_fingerprint 在场时 done 附带声口偏离（基线=正文尾巴）；工具缺失/报错静默降级不带 voice', async () => {
    const deviation = {
      deltas: {
        dialogueRatio: { base: 0.4, out: 0.12 },
        sentenceLenMean: { base: 9.5, out: 10.1 },
        shortSentenceRatio: { base: 0.5, out: 0.52 },
        longSentenceRatio: { base: 0.1, out: 0.1 },
        gramOverlap: { base: 8, out: 8 },
      },
      flags: ['对白占比 40% → 12%'],
    };
    const execute = vi.fn(async () => ({ deviation }));
    const tools = { voice_fingerprint: { description: '声口指纹', execute } } as unknown as ToolSet;
    const s = await startTestServer({ modelForTier: () => stepModel([textResult(['他说完便走。'])]), tools });
    try {
      const events = await readSse(await postContinue(s.baseUrl, s.token, { context: '他说。她说。他说。' }));
      const done = events.at(-1)!;
      expect(done.event).toBe('done');
      expect(done.data.voice).toEqual(deviation);
      // 基线=请求的 context（正文尾巴），产出=最终续写文本；texts+compare 口径
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ texts: ['他说。她说。他说。', '他说完便走。'], compare: { baselineIndex: 0, sampleIndex: 1 } }),
        expect.anything()
      );
    } finally {
      await s.close();
    }
    // 工具缺失 → done 不带 voice 字段
    const s2 = await startTestServer({ modelForTier: () => stepModel([textResult(['他说。'])]) });
    try {
      const events = await readSse(await postContinue(s2.baseUrl, s2.token, { context: '他说。' }));
      expect(events.at(-1)?.data.voice).toBeUndefined();
    } finally {
      await s2.close();
    }
    // 工具报错 → 降级不拦产出
    const bad = { voice_fingerprint: { description: '声口指纹', execute: vi.fn(async () => { throw new Error('炸了'); }) } } as unknown as ToolSet;
    const s3 = await startTestServer({ modelForTier: () => stepModel([textResult(['照常。'])]), tools: bad });
    try {
      const events = await readSse(await postContinue(s3.baseUrl, s3.token, { context: '他说。' }));
      expect(events.at(-1)?.event).toBe('done');
      expect(events.at(-1)?.data.voice).toBeUndefined();
    } finally {
      await s3.close();
    }
  });
});
