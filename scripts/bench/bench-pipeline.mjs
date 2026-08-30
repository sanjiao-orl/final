#!/usr/bin/env node
// scripts/bench/bench-pipeline.mjs —— 全量管线跑（试车台批，LLM 免费档，可断点续跑）。
//
// 子命令：
//   summaries  逐章生成摘要（generateObject 结构化）→ domain writeChapterSummary 真格式落盘
//              （导生缓存 .novel/cache/chapter-summaries.json，与产品 /v1/summary/generate 同格式；
//               提示词为试车台结构化版，与产品提示词差异记报告）
//   ledger     逐章抽账本-worthy 事实 → upsertLedger 建仪器账本（.novel/ledger.md 真格式；
//              仪器产物不走作者裁决——裁决红线管产品不管测量台）
//   metrics    账本建成后：ledger_slice/ledger_chapter_slice 尺寸分布 + reconcileLedger 耗时与命中样本
//
// 用法（需 LLM_BASE_URL/LLM_API_KEY，默认 LLM_MODEL_CHEAP）：
//   node scripts/bench/bench-pipeline.mjs summaries --work .bench/work/十日终焉 [--limit 500]
//   node scripts/bench/bench-pipeline.mjs ledger --work .bench/work/十日终焉 [--limit 500]
//   node scripts/bench/bench-pipeline.mjs metrics --work .bench/work/十日终焉 [--limit 500]
import fs from 'node:fs';
import path from 'node:path';
import { readChapters, makeModel, genJSON, usage, printUsage } from './lib.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const flagVal = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const workDir = flagVal('--work', null) ? path.resolve(flagVal('--work')) : null;
if (!cmd || !workDir || !fs.existsSync(path.join(workDir ?? '', 'manuscript'))) {
  console.error('用法：node scripts/bench/bench-pipeline.mjs <summaries|ledger|metrics> --work <工作区> [--limit N] [--concurrency 3]');
  process.exit(2);
}
const LIMIT = Number(flagVal('--limit', 500));
const CONCURRENCY = Number(flagVal('--concurrency', 3));
const manuscriptRoot = path.join(workDir, 'manuscript');
const chapters = readChapters(manuscriptRoot).slice(0, LIMIT);
console.error(`[bench] ${cmd}：${chapters.length} 章（${workDir}）`);

const stateDir = path.join(workDir, '..', '..', 'state');
const bookTag = path.basename(workDir); // 进度与角色动态按书隔离，防跨书 doneOrders 污染
fs.mkdirSync(stateDir, { recursive: true });

// tsx register：直调 domain TS 源（perf-real 同模式）
const { register } = await import('tsx/esm/api');
register();
const { writeChapterSummary, readChapterSummaries } = await import('../../domain/src/summaries.js');
const { upsertLedger, readLedger } = await import('../../domain/src/ledger.js');

const { model } = makeModel();

/** 简单并发池（串行为主，限 3 并发防免费档限流）。 */
async function pool(items, n, fn) {
  const queue = [...items];
  const workers = Array.from({ length: n }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// ================= summaries =================
const SUMMARY_SHAPE = '{"summary":"150-300字剧情摘要","tension":1到10的整数,"sceneType":"战斗|日常|过渡|高潮|悬念|情感|其他"}';
const SCENE_TYPES = new Set(['战斗', '日常', '过渡', '高潮', '悬念', '情感', '其他']);
function validateSummary(o) {
  const summary = String(o?.summary ?? '').trim();
  if (!summary) throw new Error('summary 为空');
  let tension = Math.round(Number(o.tension));
  if (!Number.isInteger(tension) || tension < 1 || tension > 10) tension = 5;
  const sceneType = SCENE_TYPES.has(o.sceneType) ? o.sceneType : '其他';
  return { summary, tension, sceneType };
}

async function runSummaries() {
  const existing = new Set(readChapterSummaries(workDir).summaries.map((s) => s.relPath));
  const todo = chapters.filter((c) => !existing.has(c.relPath));
  console.error(`[summaries] 已有 ${existing.size}，待跑 ${todo.length}`);
  let done = 0;
  let failStreak = 0; // 逐章容错：单章失败跳过（重跑续补），连续 5 章失败阻塞即停（fetcher 同款纪律）
  await pool(todo, CONCURRENCY, async (ch) => {
    try {
      const obj = await genJSON({
        model,
        shape: SUMMARY_SHAPE,
        validate: validateSummary,
        system: '你是网文连载的章节摘要员。忠实正文，不评价不发挥。',
        prompt: `为章节「${ch.title}」生成摘要与机检字段：\n\n${ch.body.slice(0, 8000)}`,
      });
      writeChapterSummary(workDir, ch.relPath, {
        summary: obj.summary,
        tension: obj.tension,
        sceneType: obj.sceneType,
        wordCount: ch.body.replace(/\s/g, '').length,
      });
      failStreak = 0;
      done++;
      if (done % 25 === 0) console.error(`[summaries] ${done}/${todo.length}`);
    } catch (err) {
      failStreak += 1;
      console.error(`[summaries] 第 ${ch.order} 章「${ch.title}」失败${failStreak >= 5 ? '——连续 5 章失败，阻塞即停' : '，跳过（重跑续补）'}: ${err.message}`);
      if (failStreak >= 5) throw err;
    }
  });
  printUsage('summaries');
}

// ================= ledger（仪器账本）=================
const EXTRACT_SHAPE =
  '{"clock":[{"storyDay":"如 第1日:夜","absoluteDate":"公历日期","thread":"主线/支线","notes":""}],"props":[{"name":"道具名","holder":"章末持有者","status":"状态","tripwire":"硬规则","quote":"原文证据短句"}],"promises":[{"name":"伏笔/承诺一句话","arc":"planted|pending|resolved|failed","quote":"原文证据","due":10}],"knowledge":[{"character":"角色","knows":["本章新增已知事实"],"doesNotKnow":["明确未知"]}],"characters":[{"name":"角色","location":"章末位置","alive":"生|死|不明","powerRank":"境界/层级","note":"","quote":""}]}' +
  '（所有数组可为空；只抽正文明确的事实）';
function validateExtract(o) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  const ARCS = ['planted', 'pending', 'resolved', 'failed'];
  return {
    clock: arr(o?.clock).filter((c) => c && typeof c === 'object'),
    props: arr(o?.props).filter((p) => p && typeof p.name === 'string' && p.name.trim()),
    promises: arr(o?.promises).filter((p) => p && typeof p.name === 'string' && p.name.trim() && ARCS.includes(p.arc)),
    knowledge: arr(o?.knowledge)
      .filter((k) => k && typeof k.character === 'string' && k.character.trim() && Array.isArray(k.knows))
      // 免费档模型偶发空串/非串 fact，域层 upsert 会整章拒收——此处归一化洗掉
      .map((k) => ({
        character: k.character,
        knows: arr(k.knows).map((f) => (typeof f === 'string' ? f : typeof f?.fact === 'string' ? f.fact : '')).map((s) => s.trim()).filter(Boolean),
        doesNotKnow: arr(k.doesNotKnow).map((f) => (typeof f === 'string' ? f : typeof f?.fact === 'string' ? f.fact : '')).map((s) => s.trim()).filter(Boolean),
      })),
    characters: arr(o?.characters).filter((c) => c && typeof c.name === 'string' && c.name.trim()),
  };
}

async function runLedger() {
  const progressPath = path.join(stateDir, `ledger-progress-${bookTag}.json`);
  const progress = fs.existsSync(progressPath) ? JSON.parse(fs.readFileSync(progressPath, 'utf8')) : { doneOrders: [] };
  const doneSet = new Set(progress.doneOrders);
  const todo = chapters.filter((c) => !doneSet.has(c.order));
  console.error(`[ledger] 已跑 ${doneSet.size}，待跑 ${todo.length}`);
  let n = 0;
  let failStreak = 0; // 同 summaries：单章失败跳过（不标 done，重跑续补），连续 5 章失败阻塞即停
  for (const ch of todo) {
    try {
      // 账本写串行（upsert 读写同一文件，不并发）
      const obj = await genJSON({
        model,
        shape: EXTRACT_SHAPE,
        validate: validateExtract,
        system:
          '你是网文连续性台账员。从本章正文抽取「跨章需要记住的事实」：时间、道具托管、伏笔埋收、角色知情与角色状态变化。' +
          '只抽正文明确的事实，带原文证据短句；拿不准不抽。' +
          '只收后续章节仍需记住的承重事实：每类数组默认不超过 3 条，仅在确有依据时超出；' +
          '过场打斗、一次性出场、对后文无影响的细节与常识性认知不抽。',
        prompt: `章节「${ch.title}」（全书第 ${ch.order} 章）：\n\n${ch.body.slice(0, 8000)}`,
      });
      const ops = [];
      for (const c of obj.clock) {
        ops.push({ op: 'clock', entry: { chapters: [ch.relPath], storyDay: c.storyDay, absoluteDate: c.absoluteDate, thread: c.thread, notes: c.notes } });
      }
      for (const p of obj.props) {
        ops.push({
          op: 'prop',
          entry: { name: p.name, holder: p.holder, status: p.status, tripwire: p.tripwire, custody: [{ chapter: ch.relPath, holder: p.holder, quote: p.quote }] },
        });
      }
      for (const pr of obj.promises) {
        const id = `P-${String(ch.order).padStart(3, '0')}-${ops.length}`;
        const entry = { id, name: pr.name, arc: pr.arc, due: Number.isInteger(pr.due) ? pr.due : undefined, setups: [], payoffs: [] };
        if (pr.arc === 'resolved' || pr.arc === 'failed') entry.payoffs.push({ chapter: ch.relPath, quote: pr.quote });
        else entry.setups.push({ chapter: ch.relPath, quote: pr.quote });
        ops.push({ op: 'promise', entry });
      }
      // knowledge：按 character 合并增量（read-merge-upsert，避免覆盖历史 knows）
      const cur = readLedger(workDir).ledger;
      for (const k of obj.knowledge) {
        const prev = cur.knowledge.find((e) => e.character === k.character);
        const merged = new Set([...(prev?.knows ?? []).map((f) => (typeof f === 'string' ? f : f.fact)), ...k.knows]);
        ops.push({
          op: 'knowledge',
          entry: {
            character: k.character,
            knows: [...merged].map((f) => ({ fact: f, since: ch.relPath })),
            doesNotKnow: k.doesNotKnow?.map((f) => ({ fact: f, since: ch.relPath })),
            visibility: prev?.visibility,
          },
        });
      }
      if (ops.length) upsertLedger(workDir, ops);
      // 角色动态变化单独落 JSONL（现有四维账本无角色维——仪器⑤的原始观测面）
      if (obj.characters.length) {
        const jl = obj.characters.map((c) => JSON.stringify({ order: ch.order, chapter: ch.relPath, ...c })).join('\n') + '\n';
        fs.appendFileSync(path.join(stateDir, `character-dynamics-${bookTag}.jsonl`), jl);
      }
      doneSet.add(ch.order);
      failStreak = 0;
    } catch (err) {
      failStreak += 1;
      console.error(`[ledger] 第 ${ch.order} 章「${ch.title}」失败${failStreak >= 5 ? '——连续 5 章失败，阻塞即停' : '，跳过（重跑续补）'}: ${err.message}`);
      if (failStreak >= 5) throw err;
      continue;
    }
    n++;
    if (n % 10 === 0) {
      progress.doneOrders = [...doneSet];
      fs.writeFileSync(progressPath, JSON.stringify(progress), 'utf8');
      console.error(`[ledger] ${n}/${todo.length}，ops 累计写入中`);
      printUsage('ledger');
    }
  }
  progress.doneOrders = [...doneSet];
  fs.writeFileSync(progressPath, JSON.stringify(progress), 'utf8');
  printUsage('ledger 完成');
}

// ================= metrics =================
async function runMetrics() {
  const { ledgerSlice, ledgerChapterSlice } = await import('../../domain/src/ledger.js');
  const { reconcileLedger } = await import('../../domain/src/reconcile.js');
  const ledgerFile = path.join(workDir, '.novel', 'ledger.md');
  const ledgerBytes = fs.existsSync(ledgerFile) ? fs.statSync(ledgerFile).size : 0;

  const sliceRows = [];
  for (let i = 0; i < chapters.length; i += 25) {
    const ch = chapters[i];
    const t0 = performance.now();
    const full = ledgerSlice(workDir, ch.relPath);
    const t1 = performance.now();
    const cs = ledgerChapterSlice(workDir, ch.relPath);
    const t2 = performance.now();
    sliceRows.push({
      order: ch.order,
      sliceChars: JSON.stringify(full).length,
      sliceMs: Math.round(t1 - t0),
      chapterSliceChars: JSON.stringify(cs).length,
      chapterSliceMs: Math.round(t2 - t1),
    });
  }
  const t0 = performance.now();
  const rec = reconcileLedger(workDir);
  const recMs = Math.round(performance.now() - t0);
  const anchors = rec.anchors ?? {};
  const out = {
    generatedAt: new Date().toISOString(),
    workDir,
    chapters: chapters.length,
    ledgerBytes,
    sliceRows,
    reconcile: { ms: recMs, anchors, findings: (rec.findings ?? []).slice(0, 20), findingsTotal: (rec.findings ?? []).length },
  };
  const outDir = flagVal('--out', '.bench/reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `ledger-metrics-${bookTag}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1), 'utf8');
  console.log(`账本 ${ledgerBytes} 字节；reconcile ${recMs}ms，findings ${out.reconcile.findingsTotal} 条；切片样本 ${sliceRows.length} 个`);
  console.log(`报告：${outPath}`);
}

if (cmd === 'summaries') await runSummaries();
else if (cmd === 'ledger') await runLedger();
else if (cmd === 'metrics') await runMetrics();
else {
  console.error(`未知子命令：${cmd}`);
  process.exit(2);
}
