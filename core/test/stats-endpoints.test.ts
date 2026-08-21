import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startTestServer } from './helpers.js';

const auth = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const body = (workDir: unknown) => JSON.stringify({ workDir });

function makeWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stats-endpoint-'));
}

describe('stats endpoints', () => {
  it('snapshot structuredContent 正常落账并返回 prev/delta，daily 升序', async () => {
    const workDir = makeWorkDir();
    const s = await startTestServer({ tools: {
      word_count: { execute: async () => ({ structuredContent: { total: 42, files: [] } }) } as never,
    } });
    try {
      const first = await fetch(`${s.baseUrl}/v1/stats/snapshot`, { method: 'POST', headers: auth(s.token), body: body(workDir) });
      expect(first.status).toBe(200);
      const firstBody = await first.json() as { date: string; words: number; prev: unknown; delta: unknown };
      expect(firstBody.words).toBe(42);
      expect(firstBody.prev).toBeNull();
      expect(firstBody.delta).toBeNull();
      expect(s.stats.list(path.resolve(workDir))).toEqual([{ date: firstBody.date, words: 42 }]);

      const second = await fetch(`${s.baseUrl}/v1/stats/snapshot`, { method: 'POST', headers: auth(s.token), body: body(workDir) });
      const secondBody = await second.json() as { date: string; words: number; prev: { date: string; words: number } | null; delta: number | null };
      expect(secondBody.prev).toBeNull(); // 同日覆盖不是前一记录日
      expect(secondBody.delta).toBeNull();

      const daily = await fetch(`${s.baseUrl}/v1/stats/daily?workDir=${encodeURIComponent(workDir)}`, { headers: { Authorization: `Bearer ${s.token}` } });
      expect(daily.status).toBe(200);
      const dailyBody = await daily.json() as { days: Array<{ date: string; words: number }> };
      expect(dailyBody.days).toEqual([{ date: firstBody.date, words: 42 }]);
    } finally { await s.close(); fs.rmSync(workDir, { recursive: true, force: true }); }
  });

  it('隔日 snapshot 计算前一记录日 delta', async () => {
    const workDir = makeWorkDir();
    const s = await startTestServer({ tools: { word_count: { execute: async () => ({ structuredContent: { total: 100 } }) } as never } });
    try {
      s.stats.upsert(path.resolve(workDir), '2000-01-01', 80);
      const res = await fetch(`${s.baseUrl}/v1/stats/snapshot`, { method: 'POST', headers: auth(s.token), body: body(workDir) });
      const result = await res.json() as { prev: { date: string; words: number } | null; delta: number | null; words: number };
      expect(result.prev).toEqual({ date: '2000-01-01', words: 80 });
      expect(result.delta).toBe(20);
      expect(result.words).toBe(100);
    } finally { await s.close(); fs.rmSync(workDir, { recursive: true, force: true }); }
  });

  it('snapshot 入参错误、工具缺失或失败返回明确错误', async () => {
    const workDir = makeWorkDir();
    const cases = [
      [{}, 400], [{ workDir: 123 }, 400],
    ] as const;
    const missing = await startTestServer();
    try {
      for (const [input, status] of cases) {
        const res = await fetch(`${missing.baseUrl}/v1/stats/snapshot`, { method: 'POST', headers: auth(missing.token), body: JSON.stringify(input) });
        expect(res.status).toBe(status);
      }
      const absent = await fetch(`${missing.baseUrl}/v1/stats/snapshot`, { method: 'POST', headers: auth(missing.token), body: body(workDir) });
      expect(absent.status).toBe(502);
    } finally { await missing.close(); }

    const failed = await startTestServer({ tools: { word_count: { execute: async () => { throw new Error('boom'); } } as never } });
    try {
      const res = await fetch(`${failed.baseUrl}/v1/stats/snapshot`, { method: 'POST', headers: auth(failed.token), body: body(workDir) });
      expect(res.status).toBe(502);
    } finally { await failed.close(); fs.rmSync(workDir, { recursive: true, force: true }); }
  });

  it('daily 空库、有数据、缺 workDir，以及两端点均需 token', async () => {
    const workDir = makeWorkDir();
    const s = await startTestServer();
    try {
      expect((await fetch(`${s.baseUrl}/v1/stats/snapshot`, { method: 'POST', body: body(workDir) })).status).toBe(401);
      expect((await fetch(`${s.baseUrl}/v1/stats/daily`)).status).toBe(401);
      const empty = await fetch(`${s.baseUrl}/v1/stats/daily?workDir=${encodeURIComponent(workDir)}`, { headers: { Authorization: `Bearer ${s.token}` } });
      expect(await empty.json()).toEqual({ days: [] });
      s.stats.upsert(path.resolve(workDir), '2024-02-02', 2);
      s.stats.upsert(path.resolve(workDir), '2024-01-01', 1);
      const populated = await fetch(`${s.baseUrl}/v1/stats/daily?workDir=${encodeURIComponent(workDir)}`, { headers: { Authorization: `Bearer ${s.token}` } });
      expect(await populated.json()).toEqual({ days: [{ date: '2024-01-01', words: 1 }, { date: '2024-02-02', words: 2 }] });
      expect((await fetch(`${s.baseUrl}/v1/stats/daily`, { headers: { Authorization: `Bearer ${s.token}` } })).status).toBe(400);
    } finally { await s.close(); fs.rmSync(workDir, { recursive: true, force: true }); }
  });
});
