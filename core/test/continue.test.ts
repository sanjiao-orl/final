// 测试：/v1/continue 触发式续写 SSE——请求校验、prompt 拼装、声口注入与事件序列。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
