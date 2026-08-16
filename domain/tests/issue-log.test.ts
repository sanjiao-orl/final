/**
 * issue-log.test.ts —— 问题日志（issues.md，CR 格式行文件）：issue_append / issue_set_status / countBlockers 状态列语义（批三-1 闭环接通）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { countBlockers, issueAppend, issueSetStatus, type IssueFinding } from '../src/ledger.js';
import { makeWorkDir, writeTree } from './helpers.js';

/** 一条字段齐全的 append 入参。 */
function finding(over: Partial<IssueFinding> = {}): IssueFinding {
  return {
    severity: 'MAJOR',
    category: 'CONT',
    quote: '关键句子',
    why: '说明',
    suggestion: '修复',
    chapter: 'manuscript/卷一/第1章.md',
    ...over,
  };
}

/** 读问题日志全文（测试断言用）。 */
function readIssues(work: string, rel = 'editorial_notes/issues.md'): string {
  return fs.readFileSync(path.join(work, rel), 'utf8');
}

describe('issueAppend', () => {
  it('续号：扫现有最大 CR 编号 +1（3 位零填充）并格式化为 9 列 CR 行', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/卷一/第1章.md': '---\ntitle: 第1章\n---\n第一行。\n第二行含关键句子。\n',
      'editorial_notes/issues.md': ['# 问题日志', '', 'CR-001 | ch1:1 | MINOR | CONT | "x" | why | fix | LINE', 'CR-008 | ch1:2 | MINOR | CONT | "y" | why | fix | LINE | done'].join('\n'),
    });
    const res = issueAppend(work, [finding()]);
    expect(res.appended).toBe(1);
    expect(res.ids).toEqual(['CR-009']);
    expect(res.path).toBe('editorial_notes/issues.md');
    // 文件实际行号：1 `---`、2 title、3 `---`、4 第一行、5 第二行含关键句子
    expect(readIssues(work)).toContain('CR-009 | manuscript/卷一/第1章.md:5 | MAJOR | CONT | "关键句子" | 说明 | 修复 | - | open');
  });

  it('行号定位：quote 首次出现行号按文件实际行号（含 frontmatter 行）', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第1章.md': '---\ntitle: 第1章\n---\n第一行。\n第二行含关键句子。\n第三行又含关键句子。\n',
    });
    issueAppend(work, [finding({ chapter: 'manuscript/第1章.md', quote: '关键句子' })]);
    expect(readIssues(work)).toContain('manuscript/第1章.md:5'); // 只取首次出现（第 5 行），非第 6 行
  });

  it('quote 找不到 / chapter 不存在 → line 段写 ?', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/卷一/第1章.md': '---\ntitle: 第1章\n---\n正文。' });
    issueAppend(work, [finding({ quote: '不存在的句子' }), finding({ chapter: 'manuscript/卷X/不存在.md' })]);
    const out = readIssues(work);
    expect(out).toContain('manuscript/卷一/第1章.md:?');
    expect(out).toContain('manuscript/卷X/不存在.md:?');
  });

  it('缺文件创建：含父目录 + `# 问题日志` 头行，从 CR-001 起', () => {
    const work = makeWorkDir();
    const res = issueAppend(work, [finding()]);
    expect(res.appended).toBe(1);
    expect(res.ids).toEqual(['CR-001']);
    const out = readIssues(work);
    expect(out.startsWith('# 问题日志')).toBe(true);
    expect(out).toContain('CR-001 | manuscript/卷一/第1章.md:? | MAJOR | CONT | "关键句子" | 说明 | 修复 | - | open');
  });

  it('suggestion 缺省 → fix 列填 -；行内 `|` 与换行替换为空格', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '---\ntitle: 第1章\n---\n正文。' });
    issueAppend(work, [
      {
        severity: 'MAJOR',
        category: 'CONT',
        quote: '带|竖线',
        why: '跨\n行说明',
        chapter: 'manuscript/第1章.md',
      },
    ]);
    const line = readIssues(work).split(/\r?\n/).find((l) => l.startsWith('CR-001'));
    expect(line).toBeDefined();
    expect(line!.split('|')).toHaveLength(9);
    expect(line!).toContain('| "带 竖线" | 跨 行说明 | - | - | open');
  });

  it('quote 带引号包裹时去引号后再定位与落列', () => {
    const work = makeWorkDir();
    writeTree(work, { 'manuscript/第1章.md': '---\ntitle: 第1章\n---\n正文含关键句子。\n' });
    issueAppend(work, [finding({ chapter: 'manuscript/第1章.md', quote: '"关键句子"' })]);
    expect(readIssues(work)).toContain('manuscript/第1章.md:4 | MAJOR | CONT | "关键句子"');
  });

  it('白名单拒绝越界：manuscript/ 章、AGENTS.md、.novel/history/ 内 .md 一律抛错', () => {
    const work = makeWorkDir();
    for (const rel of ['manuscript/第1章.md', 'AGENTS.md', '.novel/history/x.md']) {
      expect(() => issueAppend(work, [finding()], rel), rel).toThrow(/issueLogPath/);
    }
  });

  it('白名单放行 editorial_notes/ 与 .novel/ 根下 .md', () => {
    const work = makeWorkDir();
    expect(issueAppend(work, [finding()], 'editorial_notes/issues.md').path).toBe('editorial_notes/issues.md');
    expect(issueAppend(work, [finding()], '.novel/issues.md').path).toBe('.novel/issues.md');
  });

  it('非法 severity / category 抛守卫错误；空 findings 幂等 no-op 不建文件', () => {
    const work = makeWorkDir();
    expect(() => issueAppend(work, [finding({ severity: 'CRITICAL' as never })])).toThrow(/severity 非法/);
    expect(() => issueAppend(work, [finding({ category: 'XXX' as never })])).toThrow(/category 非法/);
    const res = issueAppend(work, []);
    expect(res).toEqual({ appended: 0, ids: [], path: 'editorial_notes/issues.md' });
    expect(fs.existsSync(path.join(work, 'editorial_notes', 'issues.md'))).toBe(false);
  });
});

describe('issueSetStatus', () => {
  it('有 status 列 → 替换（其余列与间隔保持不变）', () => {
    const work = makeWorkDir();
    writeTree(work, { 'editorial_notes/issues.md': 'CR-001 | ch1:1 | BLOCKER | CONT | "x" | why | fix | LINE | open\n' });
    const res = issueSetStatus(work, 'CR-001', 'done');
    expect(res).toEqual({ ok: true, id: 'CR-001', status: 'done' });
    expect(readIssues(work)).toBe('CR-001 | ch1:1 | BLOCKER | CONT | "x" | why | fix | LINE | done\n');
  });

  it('无 status 列（旧 8 列行）→ 行尾追加', () => {
    const work = makeWorkDir();
    writeTree(work, { 'editorial_notes/issues.md': 'CR-001 | ch1:1 | BLOCKER | CONT | "x" | why | fix | LINE\n' });
    const res = issueSetStatus(work, 'CR-001', 'known');
    expect(res).toEqual({ ok: true, id: 'CR-001', status: 'known' });
    expect(readIssues(work)).toBe('CR-001 | ch1:1 | BLOCKER | CONT | "x" | why | fix | LINE | known\n');
  });

  it('同状态重复设置幂等成功（文件内容不变）', () => {
    const work = makeWorkDir();
    writeTree(work, { 'editorial_notes/issues.md': 'CR-001 | ch1:1 | BLOCKER | CONT | "x" | why | fix | LINE | done\n' });
    const before = readIssues(work);
    const res = issueSetStatus(work, 'CR-001', 'done');
    expect(res.ok).toBe(true);
    expect(readIssues(work)).toBe(before);
  });

  it('未知 id 抛中文错；id 格式非法抛守卫错误', () => {
    const work = makeWorkDir();
    writeTree(work, { 'editorial_notes/issues.md': 'CR-001 | ch1:1 | BLOCKER | CONT | "x" | why | fix | LINE\n' });
    expect(() => issueSetStatus(work, 'CR-999', 'done')).toThrow(/找不到 id: CR-999/);
    expect(() => issueSetStatus(work, 'CR-1X', 'done')).toThrow(/id 格式非法/);
  });

  it('只改 CR 行：非 CR 行误含 id 文本不动', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'editorial_notes/issues.md': ['# 问题日志', '正文里提到 CR-001 但这不是 CR 行', 'CR-001 | ch1:1 | BLOCKER | CONT | "x" | why | fix | LINE | open'].join('\n'),
    });
    issueSetStatus(work, 'CR-001', 'done');
    const lines = readIssues(work).split(/\r?\n/);
    expect(lines[1]).toContain('但这不是 CR 行'); // 非 CR 行原样
    expect(lines[2]).toContain('| done'); // CR 行已改
  });

  it('白名单拒绝越界', () => {
    const work = makeWorkDir();
    expect(() => issueSetStatus(work, 'CR-001', 'done', 'manuscript/第1章.md')).toThrow(/issueLogPath/);
  });
});

describe('countBlockers（status 列语义，0009）', () => {
  it('status 缺失 / 空 / open 的 BLOCKER 计数', () => {
    const log = [
      'CR-001 | ch1:1 | BLOCKER | CONT | "a" | w | f | LINE',
      'CR-002 | ch1:2 | BLOCKER | CONT | "b" | w | f | LINE | open',
      'CR-003 | ch1:3 | BLOCKER | CONT | "c" | w | f | LINE | ',
      'CR-004 | ch1:4 | MINOR | CONT | "d" | w | f | LINE | open',
    ].join('\n');
    expect(countBlockers(log)).toEqual({ blockers: 3, hasBlockers: true });
  });

  it('status 为 done / known 的 BLOCKER 不计（清零语义）', () => {
    const log = [
      'CR-001 | ch1:1 | BLOCKER | CONT | "a" | w | f | LINE | done',
      'CR-002 | ch1:2 | BLOCKER | CONT | "b" | w | f | LINE | known',
      'CR-003 | ch1:3 | BLOCKER | CONT | "c" | w | f | LINE',
    ].join('\n');
    expect(countBlockers(log)).toEqual({ blockers: 1, hasBlockers: true });
  });

  it('全部处置后 hasBlockers=false（清零）', () => {
    const log = [
      'CR-001 | ch1:1 | BLOCKER | CONT | "a" | w | f | LINE | done',
      'CR-002 | ch1:2 | BLOCKER | CONT | "b" | w | f | LINE | known',
    ].join('\n');
    expect(countBlockers(log)).toEqual({ blockers: 0, hasBlockers: false });
  });
});
