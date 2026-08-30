#!/usr/bin/env node
// scripts/bench/perf-real.mjs —— 真实语料性能测量（试车台批；对比 perf-benchmark 的合成文本数字）。
// 对 .bench/work/<书> 真书语料跑 domain 确定性工具（scan_quality/word_count/search_content/diagnostics），
// 子进程逐格计时（借 perf-benchmark.mjs 的模式与理由：sync 工具阻塞事件循环，进程级 RSS 近似峰值内存）。
// 用法：node scripts/bench/perf-real.mjs --work .bench/work/十日终焉 [--runs 3] [--out .bench/reports]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

const TOOLS = ['scan_quality', 'word_count', 'search_content', 'diagnostics'];
const SEARCH_QUERY = process.env.MEASURE_QUERY || '齐夏'; // 主角名：真实语料的搜索热词（主流程 --query 经 env 传入子进程）
const SEARCH_LIMIT = 20;

// ---------- 子测量进程入口 ----------
if (process.env.MEASURE_TOOL) {
  const { register } = await import('tsx/esm/api');
  register();
  const workDir = process.env.MEASURE_WORK;
  const tool = process.env.MEASURE_TOOL;
  const { scanQuality, searchContent, wordCount } = await import('../../domain/src/tools.js');
  const { diagnosticsForWork } = await import('../../domain/src/ledger.js');
  const impls = {
    scan_quality: () => scanQuality(workDir),
    word_count: () => wordCount(workDir),
    search_content: () => searchContent(workDir, SEARCH_QUERY, SEARCH_LIMIT),
    diagnostics: () => diagnosticsForWork(workDir),
  };
  const fn = impls[tool];
  if (!fn) throw new Error(`perf-real 未知工具: ${tool}`);
  const RUNS = Number(process.env.MEASURE_RUNS ?? 3);
  fn(); // warmup 不计入
  globalThis.gc?.();
  const base = process.memoryUsage().rss;
  let peak = base;
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
    peak = Math.max(peak, process.memoryUsage().rss);
  }
  times.sort((a, b) => a - b);
  const mb = (x) => Math.round((x / (1024 * 1024)) * 10) / 10;
  process.stdout.write(
    JSON.stringify({ tool, medianMs: Math.round(times[Math.floor(times.length / 2)]), rssBaseMB: mb(base), rssPeakMB: mb(peak), runs: RUNS }),
  );
  process.exit(0);
}

// ---------- 主流程 ----------
const args = process.argv.slice(2);
const flagVal = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const workDir = flagVal('--work', null);
if (!workDir || !fs.existsSync(path.join(workDir, 'manuscript'))) {
  console.error('用法：node scripts/bench/perf-real.mjs --work <含 manuscript/ 的工作区目录> [--runs 3] [--out .bench/reports]');
  process.exit(2);
}
const RUNS = Number(flagVal('--runs', 3));
const outDir = flagVal('--out', '.bench/reports');
const searchQuery = flagVal('--query', '齐夏');

const chapterCount = (function count(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += count(path.join(dir, e.name));
    else if (e.name.endsWith('.md')) n++;
  }
  return n;
})(path.join(workDir, 'manuscript'));

console.log(`真实语料性能基准：${workDir}（${chapterCount} 章），每格 warmup 1 + 计时 ${RUNS} 轮取中位\n`);
const rows = [];
for (const tool of TOOLS) {
  const res = spawnSync(process.execPath, ['--expose-gc', SELF], {
    cwd: HERE,
    env: { ...process.env, MEASURE_TOOL: tool, MEASURE_WORK: path.resolve(workDir), MEASURE_RUNS: String(RUNS), MEASURE_QUERY: searchQuery },
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`子进程失败（${tool}）:\n${res.stderr}`);
  const line = res.stdout.trim().split(/\r?\n/).pop();
  rows.push(JSON.parse(line));
}

const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
console.log(`${pad('工具', 14)}  中位耗时     RSS基线     RSS峰值`);
console.log('-'.repeat(52));
for (const r of rows) {
  console.log(`${pad(r.tool, 14)}  ${pad(`${r.medianMs} ms`, 10)}  ${pad(`${r.rssBaseMB} MB`, 10)}  ${r.rssPeakMB} MB`);
}

fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `perf-real-${path.basename(path.resolve(workDir))}.json`);
fs.writeFileSync(
  outPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), workDir, chapterCount, searchQuery, rows }, null, 1),
  'utf8',
);
console.log(`\n报告：${outPath}`);
