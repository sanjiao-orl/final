#!/usr/bin/env node
// scripts/bench/ledger-checkup.mjs —— 真账本体检（0017 仪器①完全体；只出脱敏统计，正文不出本机）。
//
// 用法：node scripts/bench/ledger-checkup.mjs <真书工作区路径> [--out .bench/reports]
// 输出：条目计数/字段填充率/锚点统计/git 史演变（若工作区是 git 仓）/解析健康度。
// 不输出任何正文原文（quote 只计数不回显），统计摘要可引进试车台报告。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const workDir = args[0] ? path.resolve(args[0]) : null;
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : '.bench/reports';
if (!workDir || !fs.existsSync(workDir)) {
  console.error('用法：node scripts/bench/ledger-checkup.mjs <真书工作区路径> [--out .bench/reports]');
  process.exit(2);
}

const { register } = await import('tsx/esm/api');
register();
const { readLedger } = await import('../../domain/src/ledger.js');

// 章数
function countChapters(dir) {
  const mdir = path.join(dir, 'manuscript');
  if (!fs.existsSync(mdir)) return 0;
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.md')) n++;
    }
  };
  walk(mdir);
  return n;
}

const report = { generatedAt: new Date().toISOString(), workDir, chapters: countChapters(workDir) };

// 账本解析健康度 + 条目与字段填充率
try {
  const { ledger, path: ledgerPath } = readLedger(workDir);
  const anchors =
    ledger.clock.reduce((s, c) => s + c.chapters.length, 0) +
    ledger.props.reduce((s, p) => s + p.custody.length, 0) +
    ledger.promises.reduce((s, p) => s + p.setups.length + p.payoffs.length, 0) +
    ledger.knowledge.reduce((s, k) => s + k.knows.filter((f) => f.since).length, 0);
  const quotes =
    ledger.props.reduce((s, p) => s + p.custody.filter((c) => c.quote).length, 0) +
    ledger.promises.reduce((s, p) => s + p.setups.filter((x) => x.quote).length + p.payoffs.filter((x) => x.quote).length, 0) +
    ledger.knowledge.reduce((s, k) => s + k.knows.filter((f) => f.quote).length, 0);
  report.ledger = {
    path: ledgerPath,
    bytes: fs.statSync(path.join(workDir, ledgerPath)).size,
    clock: ledger.clock.length,
    props: ledger.props.length,
    promises: ledger.promises.length,
    knowledge: ledger.knowledge.length,
    doNotReexplain: ledger.doNotReexplain.length,
    protect: ledger.protect.length,
    tripwires: ledger.tripwires.length,
    anchors,
    quotesFilled: quotes,
    promiseArc: ledger.promises.reduce((m, p) => ((m[p.arc] = (m[p.arc] ?? 0) + 1), m), {}),
    promiseDueFilled: ledger.promises.filter((p) => p.due !== undefined).length,
    promiseExpectedVolumeFilled: ledger.promises.filter((p) => p.expectedVolume).length,
    promiseLinksFilled: ledger.promises.filter((p) => p.links && (p.links.props?.length || p.links.characters?.length)).length,
    knowledgeSinceFilled: ledger.knowledge.reduce((s, k) => s + k.knows.filter((f) => f.since).length, 0),
    knowledgeFactsTotal: ledger.knowledge.reduce((s, k) => s + k.knows.length, 0),
    knowledgeVisibility: ledger.knowledge.reduce((m, k) => ((m[k.visibility ?? 'public'] = (m[k.visibility ?? 'public'] ?? 0) + 1), m), {}),
    extraKeys: Object.keys(ledger.extra ?? {}),
  };
} catch (err) {
  report.ledger = { error: String(err?.message ?? err) };
}

// git 史演变（工作区是 git 仓才跑；只取提交计数与首尾日期）
const gitCheck = spawnSync('git', ['-C', workDir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
if (gitCheck.status === 0 && gitCheck.stdout.trim() === 'true') {
  for (const rel of ['.novel/ledger.md', '.novel']) {
    const log = spawnSync('git', ['-C', workDir, 'log', '--follow', '--format=%aI', '--', rel], { encoding: 'utf8' });
    if (log.status === 0 && log.stdout.trim()) {
      const dates = log.stdout.trim().split('\n');
      report.git = { ...(report.git ?? {}), [rel]: { commits: dates.length, first: dates.at(-1), last: dates[0] } };
    }
  }
} else {
  report.git = { note: '工作区非 git 仓，史演变缺' };
}

fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'ledger-checkup.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 1), 'utf8');
console.log(JSON.stringify(report, null, 1));
console.log(`报告：${outPath}`);
