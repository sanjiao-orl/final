/**
 * reconcile.test.ts —— 账本证据锚对账器：空账本 / 全锚命中 / 章失踪 / quote 缺失 / 行号漂移 /
 * 纯章引用锚只验存在性 / 证据锚 quote 扩展 round-trip（决策 0013）/ locateQuoteLine 导出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  emptyLedger,
  locateQuoteLine,
  parseLedger,
  serializeLedger,
  writeLedger,
  type KnowledgeFact,
  type Ledger,
} from '../src/ledger.js';
import { reconcileLedger } from '../src/reconcile.js';
import { makeWorkDir, writeTree } from './helpers.js';

/** 章正文（quote 在第 5 行：1-3 是 frontmatter，4 空行）。 */
function chapterBody(quote: string): string {
  return ['---', 'title: 章', '---', '', `林渡接过铜钱，${quote}。`, '茶棚外雨声不停。'].join('\n');
}

const CH1 = 'manuscript/第1章.md';
const CH2 = 'manuscript/第2章.md';
const Q1 = '分量不对';
const Q2 = '师父半句话未说完';

/** 搭一个两章的作品目录，返回 workDir。 */
function setupChapters(): string {
  const wd = makeWorkDir();
  writeTree(wd, { [CH1]: chapterBody(Q1), [CH2]: chapterBody(Q2) });
  return wd;
}

/** 基础账本：时钟表 + 道具托管 + 伏笔 + 知情，全部锚点指向真实存在的章与 quote。 */
function goodLedger(): Ledger {
  return {
    ...emptyLedger(),
    clock: [{ chapters: [CH1, CH2], thread: '主', storyDay: '第1日' }],
    props: [
      {
        name: '玉佩',
        custody: [
          { chapter: CH1, line: 5, holder: '林渡', quote: Q1 },
          { chapter: CH2, line: 5, holder: '张三', quote: Q2 },
        ],
      },
    ],
    promises: [
      {
        id: 'F-001',
        name: '身世之谜',
        arc: 'planted',
        setups: [{ chapter: CH1, line: 5, quote: Q1 }],
        payoffs: [{ chapter: CH2, line: 5, quote: Q2 }],
      },
    ],
    knowledge: [{ character: '张三', knows: [{ fact: '玉佩有异', since: CH1, quote: Q1 }] }],
    doNotReexplain: [],
    protect: [],
    tripwires: [],
  };
}

describe('reconcileLedger', () => {
  it('空账本（无账本文件）→ checked 0、空 findings，不抛错', () => {
    const wd = makeWorkDir();
    writeTree(wd, { [CH1]: chapterBody(Q1) }); // 有章没账本
    const r = reconcileLedger(wd);
    expect(r.anchors).toEqual({ checked: 0, ok: 0, chapterMissing: 0, quoteMissing: 0, lineDrift: 0 });
    expect(r.findings).toEqual([]);
    expect(r.skipped).toBeUndefined();
  });

  it('锚全部命中 → checked N ok N，零 findings，计数自洽', () => {
    const wd = setupChapters();
    writeLedger(wd, goodLedger());
    const r = reconcileLedger(wd);
    // 时钟表 2 个章引用 + 托管 2 步 + 埋设/回收各 1 + since 1 = 7
    expect(r.anchors.checked).toBe(7);
    expect(r.anchors.ok).toBe(7);
    expect(r.anchors.chapterMissing).toBe(0);
    expect(r.anchors.quoteMissing).toBe(0);
    expect(r.anchors.lineDrift).toBe(0);
    expect(r.anchors.checked).toBe(r.anchors.ok + r.anchors.chapterMissing + r.anchors.quoteMissing + r.anchors.lineDrift);
    expect(r.findings).toEqual([]);
  });

  it('章失踪 → anchor-chapter-missing MAJOR/CONT，message 写清来源维度', () => {
    const wd = setupChapters();
    const ledger = goodLedger();
    ledger.props[0]!.custody[0]!.chapter = 'manuscript/卷一/第9章.md'; // 指向不存在的章
    writeLedger(wd, ledger);
    const r = reconcileLedger(wd);
    expect(r.anchors.chapterMissing).toBe(1);
    expect(r.anchors.checked).toBe(7); // 失踪锚也计入 checked
    const f = r.findings.find((x) => x.code === 'anchor-chapter-missing');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('MAJOR');
    expect(f!.category).toBe('CONT');
    expect(f!.chapter).toBe('manuscript/卷一/第9章.md');
    expect(f!.message).toContain('道具托管「玉佩」');
    expect(f!.message).toContain('第9章.md');
  });

  it('quote 不在章里 → anchor-quote-missing MAJOR/CONT，message 含截断引用与出处', () => {
    const wd = setupChapters();
    const ledger = goodLedger();
    ledger.promises[0]!.setups[0]!.quote = '这句正文里根本没有的句子'.repeat(5); // 长引用顺带验截断
    writeLedger(wd, ledger);
    const r = reconcileLedger(wd);
    expect(r.anchors.quoteMissing).toBe(1);
    const f = r.findings.find((x) => x.code === 'anchor-quote-missing');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('MAJOR');
    expect(f!.category).toBe('CONT');
    expect(f!.chapter).toBe(CH1);
    expect(f!.message).toContain('伏笔 F-001「身世之谜」埋设');
    expect(f!.message).toContain('…'); // 截断标记
    expect(f!.message.length).toBeLessThan(120);
  });

  it('行号漂移（quote 在但记录行号错）→ anchor-line-drift MINOR/CONT', () => {
    const wd = setupChapters();
    const ledger = goodLedger();
    ledger.props[0]!.custody[0]!.line = 99; // quote 实际在第 5 行
    writeLedger(wd, ledger);
    const r = reconcileLedger(wd);
    expect(r.anchors.lineDrift).toBe(1);
    expect(r.anchors.ok).toBe(6);
    const f = r.findings.find((x) => x.code === 'anchor-line-drift');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('MINOR');
    expect(f!.category).toBe('CONT');
    expect(f!.message).toContain('99');
    expect(f!.message).toContain('5');
  });

  it('findings 排序稳定：MAJOR 在 MINOR 前，同级按 code 字典序', () => {
    const wd = setupChapters();
    const ledger = goodLedger();
    ledger.props[0]!.custody[0]!.chapter = 'manuscript/失踪章.md'; // anchor-chapter-missing (MAJOR)
    ledger.promises[0]!.payoffs[0]!.line = 42; // anchor-line-drift (MINOR)
    writeLedger(wd, ledger);
    const r = reconcileLedger(wd);
    expect(r.findings.map((f) => f.code)).toEqual(['anchor-chapter-missing', 'anchor-line-drift']);
  });

  it('无 quote 无 line 的纯章引用锚只验章存在性；仅记 line 的锚同样只验存在性', () => {
    const wd = setupChapters();
    const ledger = goodLedger();
    ledger.clock = [{ chapters: [CH1, CH2] }]; // 纯章引用
    ledger.props[0]!.custody = [{ chapter: CH1, line: 12345 }]; // 只记 line（脱离 quote 无法回验）
    ledger.promises = [];
    ledger.knowledge = [];
    writeLedger(wd, ledger);
    const r = reconcileLedger(wd);
    expect(r.anchors.checked).toBe(3);
    expect(r.anchors.ok).toBe(3);
    expect(r.findings).toEqual([]);
  });

  it('知情 fact 无 since 不产生锚（宁缺毋滥）', () => {
    const wd = setupChapters();
    const ledger = goodLedger();
    ledger.knowledge = [{ character: '张三', knows: [{ fact: '无时间锚的事实' }] }];
    ledger.props = [];
    ledger.promises = [];
    ledger.clock = [];
    writeLedger(wd, ledger);
    const r = reconcileLedger(wd);
    expect(r.anchors.checked).toBe(0);
    expect(r.findings).toEqual([]);
  });

  it('章位置被同名目录占位 → 章掉出 chapterOrder 判 chapter-missing，不抛错、计数自洽', () => {
    const wd = setupChapters();
    const ledger = goodLedger();
    writeLedger(wd, ledger);
    fs.rmSync(path.join(wd, CH1)); // 物理删除 CH1
    fs.mkdirSync(path.join(wd, CH1)); // 同名目录占位：collectMdFiles 只收常规文件 → CH1 掉出章序
    const r = reconcileLedger(wd);
    // CH1 相关锚（时钟表 1 + 托管 1 + 埋设 1 + since 1 = 4）全部判 chapter-missing；不抛错、计数自洽。
    // （skipped 分支需要「章在章序但读不到」的 IO 异常，无分词器式注入点，靠实现口径保证，不在此断言。）
    expect(r.anchors.chapterMissing).toBe(4);
    expect(r.anchors.checked).toBe(7);
    expect(r.anchors.checked).toBe(r.anchors.ok + r.anchors.chapterMissing + r.anchors.quoteMissing + r.anchors.lineDrift);
  });
});

describe('证据锚 quote 扩展 round-trip（决策 0013）', () => {
  it('applyOps 写入带 quote 的 custody/payoff/knowledge → serialize → parse 回来 quote 不丢', () => {
    const ledger = applyOps(emptyLedger(), [
      { op: 'prop', entry: { name: '玉佩', custody: [{ chapter: CH1, line: 5, holder: '林渡', note: '接手', quote: Q1 }] } },
      {
        op: 'promise',
        entry: { id: 'F-001', name: '身世之谜', arc: 'planted', setups: [{ chapter: CH1, quote: Q1 }], payoffs: [{ chapter: CH2, line: 5, quote: Q2 }] },
      },
      { op: 'knowledge', entry: { character: '张三', knows: [{ fact: '玉佩有异', since: CH1, refs: ['F-001'], quote: Q1 }] } },
    ]);
    const parsed = parseLedger(serializeLedger(ledger));
    expect(parsed.props[0]!.custody[0]).toEqual({ chapter: CH1, line: 5, holder: '林渡', note: '接手', quote: Q1 });
    expect(parsed.promises[0]!.setups[0]).toEqual({ chapter: CH1, quote: Q1 });
    expect(parsed.promises[0]!.payoffs[0]).toEqual({ chapter: CH2, line: 5, quote: Q2 });
    expect(parsed.knowledge[0]!.knows[0]).toEqual({ fact: '玉佩有异', since: CH1, refs: ['F-001'], quote: Q1 });
  });

  it('knowledgeForYaml：只有 fact+quote（无 since/refs）也写对象，不塌缩成纯字符串', () => {
    const ledger = applyOps(emptyLedger(), [
      { op: 'knowledge', entry: { character: '张三', knows: [{ fact: '玉佩有异', quote: Q1 }, '旧格式纯字符串' as unknown as KnowledgeFact] } },
    ]);
    const content = serializeLedger(ledger);
    // 带 quote 的项必须是对象形态（YAML 出现 quote: 键），纯字符串项保持原样
    expect(content).toMatch(/fact: 玉佩有异\n\s+quote: 分量不对/);
    expect(content).toMatch(/- 旧格式纯字符串/);
    const parsed = parseLedger(content);
    expect(parsed.knowledge[0]!.knows).toEqual([{ fact: '玉佩有异', quote: Q1 }, { fact: '旧格式纯字符串' }]);
  });

  it('渲染函数不受影响：quote 不进人读视图', () => {
    const ledger = applyOps(emptyLedger(), [
      { op: 'prop', entry: { name: '玉佩', custody: [{ chapter: CH1, quote: Q1 }] } },
    ]);
    const md = serializeLedger(ledger);
    const body = md.slice(md.indexOf('---', 4)); // 正文 = 第二个 --- 之后
    expect(body).not.toContain(Q1);
  });
});

describe('locateQuoteLine 导出', () => {
  it('已导出可用：返回 1 起始实际行号（含 frontmatter 行），找不到返回 null', () => {
    const wd = setupChapters();
    expect(locateQuoteLine(wd, CH1, Q1)).toBe(5);
    expect(locateQuoteLine(wd, CH1, '不存在的句子')).toBeNull();
    expect(locateQuoteLine(wd, 'manuscript/没有这章.md', Q1)).toBeNull();
  });

  it('D7 跨行 quote：quote 含换行（逐行必失配）→ 紧凑兜底命中起始行；LF/CRLF/段间空行差异同样命中', () => {
    const wd = makeWorkDir();
    writeTree(wd, { [CH1]: chapterBody(Q1) });
    // quote 跨第 5-6 行带 LF：原逐行 includes 必失配，紧凑剥空白后命中首字符所在行 5
    expect(locateQuoteLine(wd, CH1, `林渡接过铜钱，${Q1}。\n茶棚外雨声不停。`)).toBe(5);
    // quote 换行为 CRLF、且段间多夹一个空行 → 同样命中起始行 5
    expect(locateQuoteLine(wd, CH1, `林渡接过铜钱，${Q1}。\r\n\r\n茶棚外雨声不停。`)).toBe(5);
  });

  it('D7 空白差异：CRLF 文件逐行精确不受影响；全角/半角空格差异经紧凑兜底命中', () => {
    const crlfWd = makeWorkDir();
    writeTree(crlfWd, { [CH1]: chapterBody(Q1).replace(/\n/g, '\r\n') });
    expect(locateQuoteLine(crlfWd, CH1, `${Q1}。`)).toBe(5); // 单行 quote 逐行精确命中（回归保护）
    const spWd = makeWorkDir();
    writeTree(spWd, { [CH1]: `---\ntitle: 章\n---\n\n林渡接过铜钱，\u3000${Q1}。\n茶棚外雨声不停。` });
    expect(locateQuoteLine(spWd, CH1, `林渡接过铜钱， ${Q1}`)).toBe(5); // quote 半角空格 vs 正文全角空格
  });

  it('D7 紧凑兜底仍找不到（内容确实不存在）→ null', () => {
    const wd = setupChapters();
    expect(locateQuoteLine(wd, CH1, `不存在的句子\n另一句也没有`)).toBeNull();
  });
});
