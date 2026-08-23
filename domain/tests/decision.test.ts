/**
 * decision.test.ts —— 裁决留痕（editorial_notes/decisions.md，D 格式行文件）：
 * decision_append 追加 / decision_tail 尾部只读（批一③ 碰撞模式的裁决留痕）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decisionAppend, decisionTail } from '../src/ledger.js';
import { makeWorkDir, writeTree } from './helpers.js';

/** 读裁决留痕全文（测试断言用）。 */
function readDecisions(work: string, rel = 'editorial_notes/decisions.md'): string {
  return fs.readFileSync(path.join(work, rel), 'utf8');
}

/** 一条字段齐全的 append 入参。 */
function appendParams(over: Record<string, unknown> = {}) {
  return { topic: '人物去向', stance: '支持', ruling: '采纳', reason: '剧情需要', chapters: ['第三章'], ...over };
}

describe('decisionAppend', () => {
  it('首条建文件带头 + 编号 D-001', () => {
    const work = makeWorkDir();
    const res = decisionAppend(work, appendParams());
    expect(res).toEqual({ appended: 1, id: 'D-001', path: 'editorial_notes/decisions.md' });
    const out = readDecisions(work);
    expect(out.startsWith('# 裁决留痕')).toBe(true);
    // 日期由服务端取当天
    const date = new Date().toISOString().slice(0, 10);
    expect(out).toContain(`- D-001 | ${date} | 人物去向 | 支持 | 采纳 | 剧情需要 | 第三章`);
  });

  it('续号：扫现有最大 D 编号 +1（3 位零填充）', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'editorial_notes/decisions.md': ['# 裁决留痕', '', '- D-007 | 2026-08-20 | a | b | 采纳 | c | -'].join('\n'),
    });
    const res = decisionAppend(work, appendParams());
    expect(res.id).toBe('D-008');
    expect(readDecisions(work)).toContain('- D-008 | ');
  });

  it('字段清洗：议题/立场/理由/章内 | 与换行统一替换为空格', () => {
    const work = makeWorkDir();
    decisionAppend(work, appendParams({ topic: '带|竖线', reason: '跨\n行理由', chapters: ['章|一', '第二章'] }));
    const line = readDecisions(work).split(/\r?\n/).find((l) => l.startsWith('- D-001'));
    expect(line).toBeDefined();
    expect(line).toContain('| 带 竖线 | 支持 | 采纳 | 跨 行理由 | 章 一,第二章');
  });

  it('空 topic / stance / reason 抛中文错', () => {
    const work = makeWorkDir();
    expect(() => decisionAppend(work, appendParams({ topic: '  ' }))).toThrow(/topic 需要非空/);
    expect(() => decisionAppend(work, appendParams({ stance: '  ' }))).toThrow(/stance 需要非空/);
    expect(() => decisionAppend(work, appendParams({ reason: '  ' }))).toThrow(/reason 需要非空/);
  });

  it('ruling 枚举外抛错', () => {
    const work = makeWorkDir();
    expect(() => decisionAppend(work, appendParams({ ruling: 'invalid' }))).toThrow(/ruling 非法/);
  });

  it('path 白名单拒绝 manuscript/ 与 .novel/ 下 .md', () => {
    const work = makeWorkDir();
    expect(() => decisionAppend(work, appendParams({ path: 'manuscript/x.md' }))).toThrow(/只允许/);
    expect(() => decisionAppend(work, appendParams({ path: '.novel/x.md' }))).toThrow(/只允许/);
  });

  it('chapters 缺省 / 空数组输出 -', () => {
    const work = makeWorkDir();
    decisionAppend(work, appendParams({ chapters: undefined }));
    const line1 = readDecisions(work).split(/\r?\n/).find((l) => l.startsWith('- D-001'));
    expect(line1).toContain(' | 剧情需要 | -');
    decisionAppend(work, appendParams({ chapters: [] }));
    const line2 = readDecisions(work).split(/\r?\n/).find((l) => l.startsWith('- D-002'));
    expect(line2).toContain(' | 剧情需要 | -');
  });

  it('path 可覆盖为 editorial_notes/ 下其他 .md', () => {
    const work = makeWorkDir();
    const res = decisionAppend(work, appendParams({ path: 'editorial_notes/决策.md' }));
    expect(res.path).toBe('editorial_notes/决策.md');
    expect(fs.existsSync(path.join(work, 'editorial_notes', '决策.md'))).toBe(true);
  });

  it('读改之间留痕被外部改写 → 抛「裁决留痕已被其他进程修改」且不覆盖（CAS 复核）', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'editorial_notes/decisions.md': '# 裁决留痕\n\n- D-007 | 2026-08-20 | a | b | 采纳 | c | -',
    });
    const abs = path.join(work, 'editorial_notes', 'decisions.md');
    const realStat = fs.statSync;
    let calls = 0;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike) => {
      calls += 1;
      if (calls === 2) {
        // 模拟外部进程在「读旧留痕之后、追加写入之前」改写了文件
        fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8') + '\n<!-- external write -->\n', 'utf8');
      }
      return realStat(p);
    }) as typeof fs.statSync);
    try {
      expect(() => decisionAppend(work, appendParams())).toThrow(/裁决留痕已被其他进程修改/);
      const after = fs.readFileSync(abs, 'utf8');
      expect(after).toContain('external write'); // 外部改写内容原样保留
      expect(after).not.toContain('D-008'); // 本次追加未写入（编号不静默重复）
    } finally {
      spy.mockRestore();
    }
  });
});

describe('decisionTail', () => {
  it('文件不存在 → { total: 0, lines: [] }（降级不抛错）', () => {
    const work = makeWorkDir();
    expect(decisionTail(work)).toEqual({ total: 0, lines: [] });
    expect(decisionTail(work, '第三章')).toEqual({ total: 0, lines: [] });
  });

  it('无 chapter 取尾部 limit 行（默认 20）', () => {
    const work = makeWorkDir();
    const rows = Array.from({ length: 25 }, (_, i) => `- D-${String(i + 1).padStart(3, '0')} | 2026-08-20 | t | s | 采纳 | r | -`);
    writeTree(work, { 'editorial_notes/decisions.md': `# 裁决留痕\n\n${rows.join('\n')}\n` });
    const res = decisionTail(work);
    expect(res.total).toBe(25);
    expect(res.lines).toHaveLength(20);
    // 取尾部最新 20 条，旧的在前
    expect(res.lines![0]).toContain('D-006');
    expect(res.lines![res.lines.length - 1]).toContain('D-025');
    // 指定 limit
    expect(decisionTail(work, undefined, 5).lines).toHaveLength(5);
  });

  it('chapter 过滤优先 + 尾部补齐 + 不重复 + 原顺序', () => {
    const work = makeWorkDir();
    const rows = [
      'D-001 | 2026-08-20 | a | s | 采纳 | r | 第一章', // 0 命中
      'D-002 | 2026-08-20 | b | s | 驳回 | r | 第二章',
      'D-003 | 2026-08-20 | c | s | 采纳 | r | 第一章', // 2 命中
      'D-004 | 2026-08-20 | d | s | 搁置 | r | 第三章',
      'D-005 | 2026-08-20 | e | s | 采纳 | r | 第一章', // 4 命中
    ].map((x) => `- ${x}`);
    writeTree(work, { 'editorial_notes/decisions.md': `# 裁决留痕\n\n${rows.join('\n')}\n` });
    // 命中 3 条 ≥ limit 2 → 截断取前 2 条命中（原顺序）
    const capped = decisionTail(work, '第一章', 2);
    expect(capped.lines).toEqual([rows[0], rows[2]]);
    // 命中少于 limit（命中 2 条,limit 3）→ 尾部补齐不重复,原顺序
    const filled = decisionTail(work, '第一章', 3);
    expect(filled.lines).toEqual([rows[0], rows[2], rows[4]]);
    // 命中 3 条 + limit 4 → 尾部补齐 1 条最新未选中行(D-004),返回按文件原顺序(旧的在前)
    const filled4 = decisionTail(work, '第一章', 4);
    expect(filled4.lines).toEqual([rows[0], rows[2], rows[3], rows[4]]);
  });

  it('total 等于全文件 D 行行数', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'editorial_notes/decisions.md': ['# 裁决留痕', '', '- D-001 | d | a | b | 采纳 | c | -', '- D-002 | d | a | b | 驳回 | c | -'].join('\n'),
    });
    expect(decisionTail(work, undefined, 10).total).toBe(2);
  });
});

/**
 * 并发写竞态（评审T2）：decision_append 的 CAS 采样必须先于读内容（同 issue_append 口径）。
 * 模拟「读旧内容之后、CAS 采样之前」窗口内外部进程追加了一条裁决——
 * 修复前先读后采样，before 吸收了外部改动致 CAS 放行，stale 内容覆盖丢外部条目；
 * 修复后先采样后读，外部条目随 existing 一起进入下一次写入，不丢。
 */
describe('decisionAppend 并发写竞态（CAS 采样顺序）', () => {
  it('读旧内容与采样之间被外部改写 → 外部条目不被覆盖丢失，本次追加照常落盘', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'editorial_notes/decisions.md': '# 裁决留痕\n\n- D-007 | 2026-08-20 | a | b | 采纳 | c | -',
    });
    const abs = path.join(work, 'editorial_notes', 'decisions.md');
    const realStat = fs.statSync;
    let calls = 0;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike) => {
      calls += 1;
      if (calls === 1) {
        // 首个 statSync 落在 CAS 状态采样处；在其前注入外部追加，
        // 复现「旧内容已读走、采样尚未发生」窗口内的并发写
        fs.appendFileSync(abs, '\n- D-008 | 2026-08-20 | 外部 | 进程 | 采纳 | r | -\n');
      }
      return realStat(p);
    }) as typeof fs.statSync);
    try {
      decisionAppend(work, appendParams());
    } finally {
      spy.mockRestore();
    }
    const after = fs.readFileSync(abs, 'utf8');
    expect(after).toContain('- D-008 | 2026-08-20 | 外部'); // 外部条目原样保留（不被 stale 内容覆盖）
    expect(after).toContain('- D-009 | '); // 本次追加照常写入（编号按含外部条目续）
  });
});
