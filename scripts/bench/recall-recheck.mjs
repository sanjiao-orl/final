#!/usr/bin/env node
// scripts/bench/recall-recheck.mjs —— 4.2 召回补测（4.0+ 对照实验的挂账项，作者裁决「有条件通过」的条件）。
//
// 方法：零 LLM。复用既有资产——两臂仪器账本（基线 300 章均匀 / 分层 120 章 L3）+ 30 章地面真值
// （.bench/state/layered/spotcheck.jsonl）——用 4.1 索引层做锚级对账：
//   - 名字匹配走 queryByName 倒排 + 双向包含归一（词典制 4.3 才落，此处轻量归一并记档限定）；
//   - 章锚定走信封区间语义（intervalActiveAt + custody/since/setup 锚在本章）；
//   - 分层臂的未选区漏=覆盖率（结构性，台账诚实性）；选区内漏=真召回漏（本次度量对象）。
// 对照实验（裸子串）结论「召回被抽取不稳定性噪声主导不可判」在此升级或维持，判据预登记：
//   分层臂选区内召回率 ≥ 基线臂同章召回率 − 10pp 且基线臂率 ≥ 25% → 选区内召回相当（结构性覆盖为主）
//   否则 → 维持不可判/损失超标。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const BASE_WORK = path.join(ROOT, '.bench', 'work', '诡秘之主-净本');
const LAYER_WORK = path.join(ROOT, '.bench', 'work', '诡秘之主-净本-分层');
const STATE = path.join(ROOT, '.bench', 'state', 'layered');
const SPOT = path.join(STATE, 'spotcheck.jsonl');
const RANK = path.join(STATE, 'rank.json');

const { register } = await import('tsx/esm/api');
register();
const domainUrl = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const { readLedger } = await import(domainUrl('domain/src/ledger.ts'));
const { buildLedgerIndex, queryByName } = await import(domainUrl('domain/src/ledger-index.ts'));

/** 轻量归一：去空白/标点，小写（词典制 4.3 前的临时口径，记档）。 */
const norm = (s) => String(s ?? '').replace(/[\s，。：；、！？·“”"''（）()\-—_《》【】]/g, '').toLowerCase();

/** 双向包含（核心 ≥2 字符）。 */
function mutualContain(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return (x.includes(y) && y.length >= 2) || (y.includes(x) && x.length >= 2);
}

/** 公共子串 ≥minLen（长短语——承诺名如「交还铜哨的承诺」vs「铜哨隐患」——的判定口径；全串包含会双零）。 */
function commonSubstring(a, b, minLen = 4) {
  const x = norm(a);
  const y = norm(b);
  if (x.length < minLen || y.length < minLen) return mutualContain(a, b);
  for (let i = 0; i + minLen <= x.length; i++) {
    if (y.includes(x.slice(i, i + minLen))) return true;
  }
  return false;
}

/** 事实核心（knowledge 用，≥6 字符）。 */
function factCore(detail) {
  const c = norm(detail);
  return c.length >= 6 ? c.slice(0, 10) : '';
}

/** 锚级对账单条：地面真值事实 vs 某账本+索引。 */
function matchFact(ledger, index, fact, relPath, order) {
  if (fact.kind === 'prop') {
    for (const p of ledger.props) {
      if (!mutualContain(p.name, fact.name)) continue;
      const anchoredAtChapter = (p.custody ?? []).some((c) => c.chapter === relPath);
      const coversOrder = queryByName(index, p.name, order).some((f) => f.type === 'prop' && f.key === p.name);
      if (anchoredAtChapter || coversOrder) return { hit: true, via: anchoredAtChapter ? 'chapter-anchor' : 'interval' };
    }
    return { hit: false };
  }
  if (fact.kind === 'promise') {
    for (const p of ledger.promises) {
      if (!commonSubstring(p.name, fact.name, 4)) continue;
      const anchoredAtChapter = [...(p.setups ?? []), ...(p.payoffs ?? [])].some((a) => a.chapter === relPath);
      const active = queryByName(index, p.name, order).some((f) => f.type === 'promise' && (f.key === p.id || commonSubstring((f.payload ?? {}).name, fact.name, 4)));
      if (anchoredAtChapter || active) return { hit: true, via: anchoredAtChapter ? 'chapter-anchor' : 'interval' };
    }
    return { hit: false };
  }
  if (fact.kind === 'knowledge') {
    const core = factCore(fact.detail);
    if (!core) return { hit: false };
    for (const k of ledger.knowledge) {
      if (!mutualContain(k.character, fact.name)) continue;
      for (const kf of k.knows ?? []) {
        const f = norm(typeof kf === 'string' ? kf : kf.fact);
        if (f.includes(core.slice(0, 6)) || core.includes(f.slice(0, 6))) return { hit: true, via: 'fact-core' };
      }
    }
    return { hit: false };
  }
  return { hit: null }; // character 维：分层臂首跑未落盘，不可比（与对照实验同口径排除）
}

function measure(workDir, spot, selectedSet) {
  const { ledger } = readLedger(workDir);
  const orderTable = spot.map((s) => ({ relPath: s.chapter }));
  const index = buildLedgerIndex(ledger, orderTable);
  const kinds = ['prop', 'promise', 'knowledge'];
  const out = {
    prop: { total: 0, hit: 0 },
    promise: { total: 0, hit: 0 },
    knowledge: { total: 0, hit: 0 },
    overall: { total: 0, hit: 0 },
  };
  const layered = {
    selected: { total: 0, hit: 0 },
    unselected: { total: 0, hit: 0 },
  };
  const viaCount = { 'chapter-anchor': 0, interval: 0, 'fact-core': 0 };
  for (const row of spot) {
    const order = row.order;
    const isSel = selectedSet.has(order);
    for (const fact of row.facts) {
      const m = matchFact(ledger, index, fact, row.chapter, order);
      if (m.hit === null) continue; // character 维不可比
      out[fact.kind].total++;
      out.overall.total++;
      if (isSel) layered.selected.total++;
      else layered.unselected.total++;
      if (m.hit) {
        out[fact.kind].hit++;
        out.overall.hit++;
        viaCount[m.via] = (viaCount[m.via] ?? 0) + 1;
        if (isSel) layered.selected.hit++;
        else layered.unselected.hit++;
      }
    }
  }
  const rate = (x) => (x.total ? Math.round((x.hit / x.total) * 1000) / 10 : null);
  return {
    byKind: {
      prop: { ...out.prop, rate: rate(out.prop) },
      promise: { ...out.promise, rate: rate(out.promise) },
      knowledge: { ...out.knowledge, rate: rate(out.knowledge) },
    },
    overall: { ...out.overall, rate: rate(out.overall) },
    ...(workDir === LAYER_WORK ? { coverageSplit: { selected: { ...layered.selected, rate: rate(layered.selected) }, unselected: { ...layered.unselected, rate: rate(layered.unselected) } }, via: viaCount } : {}),
  };
}

// ---- 主流程 ----
const spot = fs.existsSync(SPOT) ? fs.readFileSync(SPOT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
if (spot.length === 0) throw new Error('地面真值缺失：先跑 layered-pipeline spotcheck');
const { selected = [] } = JSON.parse(fs.readFileSync(RANK, 'utf8'));
const selectedSet = new Set(selected);

const baseline = measure(BASE_WORK, spot, selectedSet);
const layered = measure(LAYER_WORK, spot, selectedSet);

// 判据（预登记于对照实验工作件，三分）：相对门限=分层选区内 ≥ 基线 −10pp；绝对前置=基线 ≥25%。
// 相对过+绝对过 → 选区内召回相当；相对过+绝对不过 → 部分升级（相对相当但绝对水位受抽取稳定性限制）；
// 相对不过 → 损失超标。
const b = baseline.overall.rate;
const ls = layered.coverageSplit.selected.rate;
const diff = b !== null && ls !== null ? Math.round((ls - b) * 10) / 10 : null;
const relativePass = b !== null && ls !== null && ls >= b - 10;
const absolutePass = b !== null && b >= 25;
const unselectedRate = layered.coverageSplit.unselected.rate;
const verdict =
  b === null || ls === null
    ? '不可判（样本不足）'
    : relativePass && absolutePass
      ? `选区内召回相当（分层选区内 ${ls}% vs 基线 ${b}%，差 ${diff}pp ≥ −10pp 门限，且基线 ≥25%）——对照实验「噪声主导不可判」升级为「选区内相当，损失主要来自覆盖率（结构性）」`
      : relativePass
        ? `部分升级：相对相当（分层选区内 ${ls}% vs 基线 ${b}%，差 ${diff}pp 在 −10pp 门限内），但绝对水位 ${b}% 未达 25% 前置——两臂同章独立抽取的一致性地板仍受抽取不稳定性限制；另区间投影使分层臂未选区命中 ${unselectedRate}%（裸子串口径曾为 0），0017 区间语义的覆盖价值首次可测`
        : `维持损失超标（分层选区内 ${ls}% vs 基线 ${b}%，差 ${diff}pp，未达 −10pp 门限）`;

const oldRun = { baselineRate: 7.6, layeredRate: 2.6, method: '裸子串（全账本 hay 包含，跨章巧合污染）' };
const out = {
  generatedAt: new Date().toISOString(),
  method: '4.1 索引层锚级对账（queryByName 倒排 + 区间生效 + 章锚 + 轻量归一；词典制 4.3 前限定记档）',
  spotChapters: spot.length,
  selectedChapters: selected.length,
  baseline,
  layered,
  oldRun,
  verdict,
};
const outPath = path.join(ROOT, '.bench', 'reports', 'recall-recheck-对照补测.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 1), 'utf8');
console.log(JSON.stringify({ baseline: baseline.overall, layered: layered.overall, layeredCoverageSplit: layered.coverageSplit, verdict }, null, 1));
console.log(`报告：${outPath}`);
