/**
 * cancellation.test.ts —— 重循环工具的请求取消（P2 台账：abort 后 domain 侧全量扫描应立即停止）。
 *
 * 口径：实现函数加可选 signal，逐章/逐文件循环每轮 `signal?.throwIfAborted()`——取消时抛
 * DOMException AbortError（MCP 层转成 error response），且未跑完全部章。
 *
 * 中段 abort 用确定性手段触发：vi.spyOn(fs, 'readFileSync') 在第 N 次读到 manuscript 内文件时
 * ac.abort()——不依赖时间，断言用「已读盘次数 < 总章数」而非耗时。
 */
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanWork } from '../src/qualityScan.js';
import { diagnosticsForWork } from '../src/ledger.js';
import { reconcileLedger } from '../src/reconcile.js';
import { exportTxt, listStructure, searchContent, wordCount } from '../src/tools.js';
import { makeWorkDir, writeTree } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** 造一本 N 章的作品（每章 frontmatter + 唯一正文，正文含可被账本锚定的引用串）。 */
function makeBook(dir: string, n: number): void {
  const files: Record<string, string> = {};
  for (let i = 1; i <= n; i++) {
    files[`manuscript/第${i}章·测试.md`] =
      `---\ntitle: 第${i}章·测试\nstatus: 草稿\n---\n\n第${i}章正文的原文引用。他望向远方。\n`;
  }
  writeTree(dir, files);
}

/**
 * 在第 n 次读取路径含 needle 的文件前触发 ac.abort()（其余读盘照常透传真实 readFileSync）。
 * 返回 reads() 记录「已读到的匹配文件数」，供断言未跑完全部章。
 */
function abortOnNthRead(ac: AbortController, needle: string, n: number): { reads: () => number } {
  let reads = 0;
  const real = fs.readFileSync.bind(fs);
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, options?: unknown) => {
    if (String(file).includes(needle)) {
      reads += 1;
      if (reads >= n && !ac.signal.aborted) ac.abort();
    }
    return real(file as Parameters<typeof fs.readFileSync>[0], options as BufferEncoding | undefined);
  }) as typeof fs.readFileSync);
  return { reads: () => reads };
}

/** 同步实现的统一断言：以 AbortError（DOMException）抛出。 */
function expectAbortError(run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DOMException);
  expect((caught as Error).name).toBe('AbortError');
}

describe('scan_quality 取消', () => {
  it('扫描中段 abort：以 AbortError 抛出且未读完全部章', () => {
    const wd = makeWorkDir();
    makeBook(wd, 6);
    const ac = new AbortController();
    const { reads } = abortOnNthRead(ac, 'manuscript', 2);
    expectAbortError(() => scanWork(wd, ac.signal));
    expect(reads()).toBeLessThan(6); // 第 2 章后停住，没扫完 6 章
  });

  it('handler 视角：async 包一层后 promise 以 AbortError 拒绝', async () => {
    const wd = makeWorkDir();
    makeBook(wd, 4);
    const ac = new AbortController();
    const { reads } = abortOnNthRead(ac, 'manuscript', 2);
    await expect(
      Promise.resolve().then(() => scanWork(wd, ac.signal)), // 模拟 MCP handler 的 async 包装
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads()).toBeLessThan(4);
  });

  it('不传 signal 时行为不变：跑完全部章', () => {
    const wd = makeWorkDir();
    makeBook(wd, 3);
    expect(scanWork(wd).chapters).toHaveLength(3);
  });
});

describe('word_count 汇总路径取消', () => {
  it('逐章汇总中段 abort：AbortError 且未读完全部章；预 abort 则一章都不读', () => {
    const wd = makeWorkDir();
    makeBook(wd, 5);

    const mid = new AbortController();
    const midReads = abortOnNthRead(mid, 'manuscript', 2);
    expectAbortError(() => wordCount(wd, undefined, mid.signal));
    expect(midReads.reads()).toBeLessThan(5);

    const pre = new AbortController();
    pre.abort(); // 预先取消：进循环第一轮就抛
    const preReads = abortOnNthRead(pre, 'manuscript', 1);
    expectAbortError(() => wordCount(wd, undefined, pre.signal));
    expect(preReads.reads()).toBe(0);
  });

  it('单章路径不受影响（relPath 给了只读该章）', () => {
    const wd = makeWorkDir();
    makeBook(wd, 3);
    const r = wordCount(wd, 'manuscript/第1章·测试.md');
    expect(r.total).toBeGreaterThan(0);
    expect(r.files).toBeUndefined();
  });
});

describe('ledger_diagnostics 取消', () => {
  it('全量诊断逐章循环中段 abort：AbortError 且未读完全部章', () => {
    const wd = makeWorkDir();
    makeBook(wd, 5);
    const ac = new AbortController();
    const { reads } = abortOnNthRead(ac, 'manuscript', 2);
    expectAbortError(() => diagnosticsForWork(wd, undefined, undefined, ac.signal));
    expect(reads()).toBeLessThan(5);
  });
});

describe('ledger_reconcile 取消', () => {
  it('逐锚回验循环中段 abort：AbortError 且未回验完全部锚', () => {
    const wd = makeWorkDir();
    makeBook(wd, 4);
    // 账本登记 4 个带 quote 的埋设锚（每锚回验要读两次正文：探活 + locateQuoteLine）
    writeTree(wd, {
      '.novel/ledger.md': [
        '---',
        'promises:',
        '  - id: F-001',
        '    name: 测试伏笔',
        '    arc: planted',
        '    setups:',
        ...[1, 2, 3, 4].flatMap((i) => [
          `      - chapter: manuscript/第${i}章·测试.md`,
          `        quote: 第${i}章正文的原文引用`,
        ]),
        '---',
        '',
      ].join('\n'),
    });
    const ac = new AbortController();
    const { reads } = abortOnNthRead(ac, 'manuscript', 3); // 第 2 个锚处理中途取消
    expectAbortError(() => reconcileLedger(wd, undefined, ac.signal));
    expect(reads()).toBeLessThan(8); // 4 锚 × 2 读 = 8 次读盘没跑完
  });
});

describe('export_txt 取消', () => {
  it('导出逐章循环中段 abort：AbortError、未读完全部章且不落导出文件', () => {
    const wd = makeWorkDir();
    makeBook(wd, 5);
    const ac = new AbortController();
    // listStructure 阶段先读 5 章，导出循环再逐章读：在第 7 次（=导出循环第 2 章）取消
    const { reads } = abortOnNthRead(ac, 'manuscript', 7);
    expectAbortError(() => exportTxt(wd, ac.signal));
    expect(reads()).toBeLessThan(10); // 全程共需 10 次读盘，未跑完
    const leftovers = fs.readdirSync(wd).filter((name) => name.startsWith('全稿-'));
    expect(leftovers).toEqual([]); // 中途取消不落任何导出产物
  });
});

describe('search_content / list_structure 取消（一致性补齐）', () => {
  it('search_content 逐文件扫描中段 abort：AbortError 且未扫完全部章', () => {
    const wd = makeWorkDir();
    makeBook(wd, 5); // 每章都含「正文」→ 命中不足默认 limit=20，会扫全部文件
    const ac = new AbortController();
    const { reads } = abortOnNthRead(ac, 'manuscript', 2);
    expectAbortError(() => searchContent(wd, '正文', 20, ac.signal));
    expect(reads()).toBeLessThan(5);
  });

  it('list_structure 逐章建树中段 abort：AbortError 且未读完全部章', () => {
    const wd = makeWorkDir();
    makeBook(wd, 5);
    const ac = new AbortController();
    const { reads } = abortOnNthRead(ac, 'manuscript', 2);
    expectAbortError(() => listStructure(wd, ac.signal));
    expect(reads()).toBeLessThan(5);
  });

  it('export_chapter_text 底层 listStructure 全量读盘同样可取消', () => {
    const wd = makeWorkDir();
    makeBook(wd, 5);
    const ac = new AbortController();
    const { reads } = abortOnNthRead(ac, 'manuscript', 2);
    expectAbortError(() => listStructure(wd, ac.signal)); // export_chapter_text 走同一 listStructure 全量读盘路径
    expect(reads()).toBeLessThan(5);
  });
});
