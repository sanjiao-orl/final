/**
 * summaries.test.ts —— 章摘要导生缓存：round-trip、冻结语义、校验、stale、节奏诊断、损坏焚毁重建。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pacingDiagnostics, readChapterSummaries, writeChapterSummary } from '../src/summaries.js';
import { makeWorkDir, writeTree } from './helpers.js';

const CACHE_REL = path.join('.novel', 'cache', 'chapter-summaries.json');

/** 造 6 章作品并按给定张力写满缓存。 */
function workWithTensions(tensions: number[]): string {
  const work = makeWorkDir();
  const files: Record<string, string> = {};
  for (let i = 1; i <= 6; i++) {
    files[`manuscript/第${i}章.md`] = `---\ntitle: 第${i}章\n---\n正文${i}。`;
  }
  writeTree(work, files);
  tensions.forEach((t, i) => {
    writeChapterSummary(work, `manuscript/第${i + 1}章.md`, { summary: `摘${i + 1}`, tension: t });
  });
  return work;
}

describe('write → read round-trip', () => {
  it('写入后可读回全部字段', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '---\ntitle: 一\n---\n正文。' });
    const r = writeChapterSummary(work, 'manuscript/第1章.md', {
      summary: '少年下山。',
      tension: 7,
      sceneType: '过渡',
      wordCount: 2100,
    });
    expect(r).toEqual({ ok: true, frozen: false });
    const { summaries } = readChapterSummaries(work);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      relPath: 'manuscript/第1章.md',
      summary: '少年下山。',
      tension: 7,
      sceneType: '过渡',
      wordCount: 2100,
    });
    expect(summaries[0]!.generatedAt).toBeTruthy();
    expect(summaries[0]!.stale).toBeUndefined();
  });

  it('单章查询：只返回该章；不存在的章 → 空数组', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第1章.md': '正文。',
      'manuscript/第2章.md': '正文。',
    });
    writeChapterSummary(work, 'manuscript/第1章.md', { summary: '一' });
    writeChapterSummary(work, 'manuscript/第2章.md', { summary: '二' });
    expect(readChapterSummaries(work, 'manuscript/第2章.md').summaries.map((s) => s.summary)).toEqual(['二']);
    expect(readChapterSummaries(work, 'manuscript/第3章.md').summaries).toEqual([]);
  });

  it('全部查询按章序排（编号感知，非字典序）', () => {
    const work = makeWorkDir();
    const files: Record<string, string> = {};
    for (let i = 1; i <= 11; i++) files[`manuscript/卷一/第${i}章.md`] = `正文${i}。`;
    writeTree(work, files);
    for (let i = 1; i <= 11; i++) {
      writeChapterSummary(work, `manuscript/卷一/第${i}章.md`, { summary: `摘${i}` });
    }
    const { summaries } = readChapterSummaries(work);
    // 字典序会把 第10/11章 排到 第2章 前；必须按阅读序输出
    expect(summaries.map((s) => s.relPath)).toEqual(
      Array.from({ length: 11 }, (_, i) => `manuscript/卷一/第${i + 1}章.md`),
    );
  });
});

describe('冻结语义（0013 决策4）', () => {
  it('二次写不同 tension：机检字段保持旧值、summary 更新、frozen=true', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '正文。' });
    writeChapterSummary(work, 'manuscript/第1章.md', { summary: '旧摘要', tension: 8, sceneType: '战斗' });
    const r = writeChapterSummary(work, 'manuscript/第1章.md', { summary: '新摘要', tension: 3, sceneType: '日常' });
    expect(r.frozen).toBe(true);
    const [rec] = readChapterSummaries(work).summaries;
    expect(rec!.summary).toBe('新摘要'); // summary 总更新
    expect(rec!.tension).toBe(8); // 冻结
    expect(rec!.sceneType).toBe('战斗');
  });

  it('旧记录缺 tension 时二次写补上（首写未发生）', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '正文。' });
    writeChapterSummary(work, 'manuscript/第1章.md', { summary: '只有散文' });
    const r = writeChapterSummary(work, 'manuscript/第1章.md', { summary: '补上', tension: 5 });
    expect(r.frozen).toBe(false); // 没有字段被冻结
    const [rec] = readChapterSummaries(work).summaries;
    expect(rec!.summary).toBe('补上');
    expect(rec!.tension).toBe(5);
  });
});

describe('write 校验', () => {
  it('relPath 不在章序内抛中文错', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '正文。' });
    expect(() => writeChapterSummary(work, 'manuscript/不存在.md', { summary: 'x' })).toThrow('不在当前章序内');
  });

  it('tension=0 / 11 / 3.5 抛错；边界 1 和 10 合法', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '正文。' });
    for (const bad of [0, 11, 3.5]) {
      expect(() => writeChapterSummary(work, 'manuscript/第1章.md', { summary: 'x', tension: bad })).toThrow('tension');
    }
    expect(() => writeChapterSummary(work, 'manuscript/第1章.md', { summary: 'x', tension: 1 })).not.toThrow();
    expect(() => writeChapterSummary(work, 'manuscript/第1章.md', { summary: 'x', tension: 10 })).not.toThrow();
  });

  it('summary 为空字符串抛错', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '正文。' });
    expect(() => writeChapterSummary(work, 'manuscript/第1章.md', { summary: '' })).toThrow('summary');
    expect(() => writeChapterSummary(work, 'manuscript/第1章.md', { summary: '   ' })).toThrow('summary');
  });
});

describe('stale 标记与排序', () => {
  it('删章后 read 标 stale:true 且排最后', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/a.md': '正文。',
      'manuscript/z.md': '正文。',
    });
    writeChapterSummary(work, 'manuscript/a.md', { summary: '甲' });
    writeChapterSummary(work, 'manuscript/z.md', { summary: '乙' });
    fs.rmSync(path.join(work, 'manuscript', 'a.md'));
    const { summaries } = readChapterSummaries(work);
    expect(summaries.map((s) => s.relPath)).toEqual(['manuscript/z.md', 'manuscript/a.md']);
    expect(summaries[0]!.stale).toBeUndefined();
    expect(summaries[1]!.stale).toBe(true);
  });
});

describe('pacingDiagnostics 节奏诊断', () => {
  it('尾部连续 4 章 ≤4：不报（不足 5）', () => {
    const work = workWithTensions([3, 3, 4, 2, 3, 8]);
    expect(pacingDiagnostics(work)).toEqual([]);
  });

  it('尾部连续 5 章 ≤4：报一条 pacing-flat（MODERATE/PACE，chapter=连续段首章）', () => {
    const work = workWithTensions([7, 3, 4, 2, 3, 3]);
    const findings = pacingDiagnostics(work);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: 'pacing-flat',
      chapter: 'manuscript/第2章.md',
      severity: 'MODERATE',
      category: 'PACE',
    });
    expect(findings[0]!.message).toContain('连续 5 章');
    expect(findings[0]!.message).toContain('第2章');
  });

  it('全序列都平（6 章全 ≤4）：仍只报一条，段首为第一章', () => {
    const work = workWithTensions([3, 3, 4, 2, 3, 3]);
    const findings = pacingDiagnostics(work);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.chapter).toBe('manuscript/第1章.md');
    expect(findings[0]!.message).toContain('连续 6 章');
  });

  it('序列不足 5 章或缓存不存在 → 空数组', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '正文。' });
    writeChapterSummary(work, 'manuscript/第1章.md', { summary: 'x', tension: 3 });
    expect(pacingDiagnostics(work)).toEqual([]); // 只有 1 章
    expect(pacingDiagnostics(makeWorkDir())).toEqual([]); // 缓存不存在
  });
});

describe('缓存损坏：焚毁重建（导生纪律）', () => {
  it('非法 JSON → read 空 + console.warn；pacing 空；write 可重建', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '正文。' });
    writeChapterSummary(work, 'manuscript/第1章.md', { summary: '初版', tension: 6 });
    // 手写损坏
    fs.writeFileSync(path.join(work, CACHE_REL), '{ 这不是 JSON', 'utf8');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(readChapterSummaries(work).summaries).toEqual([]);
      expect(pacingDiagnostics(work)).toEqual([]);
      // write 从空重建成功
      const r = writeChapterSummary(work, 'manuscript/第1章.md', { summary: '重建', tension: 9 });
      expect(r.ok).toBe(true);
      const [rec] = readChapterSummaries(work).summaries;
      expect(rec!.summary).toBe('重建');
      expect(rec!.tension).toBe(9); // 损坏即焚毁，无历史值可冻结
      expect(warnSpy).toHaveBeenCalled();
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('已损坏');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('before 参数（前章摘要注入用）', () => {
  it('返回章序中该章之前最近一章有摘要的记录；中间章无摘要则跳过', () => {
    const work = workWithTensions([5, 6, 7, 8, 9, 4]);
    // 删掉第5章的摘要（模拟中间章未生成）
    fs.rmSync(path.join(work, CACHE_REL));
    writeChapterSummary(work, 'manuscript/第1章.md', { summary: '摘1', tension: 5 });
    writeChapterSummary(work, 'manuscript/第3章.md', { summary: '摘3', tension: 7 });
    const r = readChapterSummaries(work, undefined, { before: 'manuscript/第4章.md' });
    expect(r.summaries).toHaveLength(1);
    expect(r.summaries[0]!.relPath).toBe('manuscript/第3章.md');
    expect(r.summaries[0]!.summary).toBe('摘3');
  });

  it('首章无前章 → 空数组；before 不在章序内 → 空数组', () => {
    const work = workWithTensions([5, 6, 7, 8, 9, 4]);
    expect(readChapterSummaries(work, undefined, { before: 'manuscript/第1章.md' }).summaries).toEqual([]);
    expect(readChapterSummaries(work, undefined, { before: 'manuscript/第99章.md' }).summaries).toEqual([]);
  });
});
