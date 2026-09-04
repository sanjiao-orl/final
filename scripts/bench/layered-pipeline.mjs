#!/usr/bin/env node
// scripts/bench/layered-pipeline.mjs —— 4.0+ 对照实验：0018 分层管线臂（reference/06）。
//
// 对照设计：同一净本 v1.2 前 300 章、同一摘要缓存、同一抽取提示词（L3 与基线臂同 EXTRACT_SHAPE），
// 分层臂产物完全隔离进独立工作区，不触碰基线臂账本。粗层（L1/L2/对撞）不产事实锚（铁律 1），
// 只有 L3 精读可写账本事实；漏读区域显式记录进覆盖率台账（铁律 2）。
//
// 子命令（均幂等可续跑，状态在 .bench/state/layered/）：
//   setup     建分层工作区（复制前 300 章正文+摘要缓存——基线臂零接触）
//   l1        簇摘要→弧线→事件骨架粗稿（自顶先验，1 call/簇×12）
//   l2        两章一段簇内平铺挖事件（1 call/段×150，粗层不产锚）
//   collide   自顶×自底互认领对撞（1 call/簇×12）→ 合并事件表+疑点
//   rank      确定性注意力排序（层级权重×承重代理×检测器加成）→ L3 选章清单
//   l3        需求驱动精读：选中部章逐章深抽（与基线臂同提示词）→ upsertLedger 入分层账本
//   spotcheck 分层抽样 30 章均匀深抽（地面真值，只落 JSONL 不入账）
//   compare   确定性出数：成本/密度/精度/召回/失控检出 → .bench/reports/ 对照 JSON
//
// 用法（通道=试车台同款 OpenRouter 免费档）：
//   LLM_BASE_URL=https://openrouter.ai/api/v1 LLM_API_KEY=$OPENROUTER_API_KEY \
//   LLM_MODEL_CHEAP=minimax/minimax-m3:free node scripts/bench/layered-pipeline.mjs <cmd>
import fs from 'node:fs';
import path from 'node:path';
import { readChapters, makeModel, genJSON, usage, printUsage } from './lib.mjs';

const BASE_WORK = path.resolve('.bench/work/诡秘之主-净本'); // 基线臂（只读）
const LAYER_WORK = path.resolve('.bench/work/诡秘之主-净本-分层'); // 分层臂工作区
const STATE_DIR = path.resolve('.bench/state/layered');
const SCOPE = 300; // 对照范围=前 300 章（与基线臂同台）
const CLUSTER = 25; // L1 簇粒度（确定性：按 order 均分 12 簇）
fs.mkdirSync(STATE_DIR, { recursive: true });

const stateFile = (name) => path.join(STATE_DIR, name);
const loadState = (name, fallback) => {
  const p = stateFile(name);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
};
const saveState = (name, obj) => fs.writeFileSync(stateFile(name), JSON.stringify(obj, null, 1), 'utf8');

// tsx register：直调 domain TS 源（bench-pipeline 同模式）
const { register } = await import('tsx/esm/api');
register();
const { upsertLedger, readLedger } = await import('../../domain/src/ledger.js');
const { readChapterSummaries } = await import('../../domain/src/summaries.js');

const cmd = process.argv[2];
const CONCURRENCY = Number(process.argv.includes('--concurrency') ? process.argv[process.argv.indexOf('--concurrency') + 1] : 3);

/** 简单并发池（限 3 并发防免费档限流，bench-pipeline 同款）。 */
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

// ============ 基线章表（对照范围） ============
const baseChapters = readChapters(path.join(BASE_WORK, 'manuscript')).slice(0, SCOPE);
if (baseChapters.length < SCOPE) throw new Error(`基线章数不足：${baseChapters.length}`);
const summaries = readChapterSummaries(BASE_WORK); // 摘要缓存（两臂共用，公平）
const sumByRel = new Map(summaries.summaries.map((s) => [s.relPath, s]));

// ============ setup：分层工作区 ============
function cmdSetup() {
  const msRoot = path.join(LAYER_WORK, 'manuscript', '正文');
  fs.mkdirSync(msRoot, { recursive: true });
  let copied = 0;
  for (const ch of baseChapters) {
    const src = path.join(BASE_WORK, ch.relPath);
    const dst = path.join(LAYER_WORK, ch.relPath);
    if (!fs.existsSync(dst)) {
      fs.writeFileSync(dst, fs.readFileSync(src));
      copied++;
    }
  }
  // 摘要缓存整份复制（恰好 300 条，两臂同源）
  const cacheSrc = path.join(BASE_WORK, '.novel', 'cache', 'chapter-summaries.json');
  const cacheDir = path.join(LAYER_WORK, '.novel', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheDst = path.join(cacheDir, 'chapter-summaries.json');
  if (!fs.existsSync(cacheDst)) fs.copyFileSync(cacheSrc, cacheDst);
  console.log(`[setup] 分层工作区就绪：复制 ${copied} 章（增量），摘要缓存 ${fs.existsSync(cacheDst) ? '在位' : '失败'}`);
}

// ============ L1：纲要层（自顶先验） ============
const L1_SHAPE =
  '{"arcTitle":"弧线名","arcSummary":"300字内弧线摘要","events":[{"title":"事件名","spanFrom":起始章order,"spanTo":结束章order,"gist":"一句话梗概","weight":1到5整数(弧内承重)}]}（events 8~15 个，覆盖本簇主线）';
function cmdL1() {
  const done = loadState('l1.json', {});
  const { model } = makeModel();
  const clusters = [];
  for (let i = 0; i < SCOPE; i += CLUSTER) clusters.push(baseChapters.slice(i, i + CLUSTER));
  return pool(
    clusters,
    CONCURRENCY,
    async (cluster) => {
      const key = `${cluster[0].order}-${cluster.at(-1).order}`;
      if (done[key]) return;
      const digest = cluster
        .map((c) => `第${c.order}章「${c.title}」：${sumByRel.get(c.relPath)?.summary ?? '（无摘要）'}`)
        .join('\n');
      const obj = await genJSON({
        model,
        shape: L1_SHAPE,
        system: '你是网文结构编辑。基于章节摘要做弧线归纳与事件骨架粗稿；忠实摘要内容，不虚构章节号。',
        prompt: `以下为第 ${key} 章的逐章摘要。归纳本簇弧线，并自顶向下给出事件骨架（事件=有起止的剧情单元）：\n\n${digest}`,
        validate: (o) => {
          const ev = (Array.isArray(o?.events) ? o.events : []).filter(
            (e) => e && typeof e.title === 'string' && Number.isFinite(Number(e.spanFrom)) && Number.isFinite(Number(e.spanTo))
          );
          if (!o?.arcTitle || ev.length < 3) throw new Error(`L1 输出不合法：events=${ev.length}`);
          return {
            arcTitle: String(o.arcTitle),
            arcSummary: String(o.arcSummary ?? ''),
            events: ev.map((e) => ({
              title: e.title,
              spanFrom: Math.max(1, Math.round(Number(e.spanFrom))),
              spanTo: Math.min(SCOPE, Math.round(Number(e.spanTo))),
              gist: String(e.gist ?? ''),
              weight: Math.min(5, Math.max(1, Math.round(Number(e.weight) || 3))),
            })),
          };
        },
      });
      done[key] = obj;
      saveState('l1.json', done);
      console.error(`[l1] 簇 ${key} ✅ ${obj.events.length} 事件`);
    }
  ).then(() => printUsage('l1'));
}

// ============ L2：事件平铺层（自底，粗层不产锚） ============
const L2_SHAPE =
  '{"events":[{"title":"事件名","chapterFrom":起始章order,"chapterTo":结束章order,"participants":["角色名"],"gist":"一句话梗概","isPromise":true或false(涉及伏笔/承诺/约定)"}]}（只列正文实际发生的事件；每段 3~10 个）';
function cmdL2() {
  const done = loadState('l2.json', {});
  const { model } = makeModel();
  const segments = [];
  for (let i = 0; i < SCOPE; i += 2) segments.push(baseChapters.slice(i, i + 2));
  let failStreak = 0;
  return pool(
    segments,
    CONCURRENCY,
    async (seg) => {
      const key = `${seg[0].order}`;
      if (done[key]) return;
      try {
        const text = seg.map((c) => `【第${c.order}章 ${c.title}】\n${c.body.slice(0, 4200)}`).join('\n\n');
        const obj = await genJSON({
          model,
          shape: L2_SHAPE,
          system: '你是网文事件梳理员。平铺挖掘正文实际发生的事件（有明确剧情内容的单元）；只输出章号区间，不摘原文引文。',
          prompt: text,
          validate: (o) => {
            const ev = (Array.isArray(o?.events) ? o.events : []).filter(
              (e) => e && typeof e.title === 'string' && Number.isFinite(Number(e.chapterFrom))
            );
            if (ev.length < 1) throw new Error('L2 空事件');
            return {
              events: ev.map((e) => ({
                title: e.title,
                chapterFrom: Math.round(Number(e.chapterFrom)),
                chapterTo: Math.round(Number(e.chapterTo ?? e.chapterFrom)),
                participants: (Array.isArray(e.participants) ? e.participants : []).filter((p) => typeof p === 'string'),
                gist: String(e.gist ?? ''),
                isPromise: Boolean(e.isPromise),
              })),
            };
          },
        });
        done[key] = obj;
        saveState('l2.json', done);
        failStreak = 0;
      } catch (err) {
        failStreak += 1;
        console.error(`[l2] 段 ${key} 失败${failStreak >= 5 ? '——阻塞即停' : '，跳过'}: ${err.message}`);
        if (failStreak >= 5) throw err;
      }
    }
  ).then(() => printUsage('l2'));
}

// ============ collide：两方向对撞（互认领） ============
const COLLIDE_SHAPE =
  '{"claims":[{"l2Title":"L2事件名","l1Title":"认领它的L1事件名,无匹配填 null","verdict":"claimed|orphan"}],"hollows":[{"l1Title":"无任何L2事件认领的L1事件名","suspect":"疑点猜测一句话"}]}';
function cmdCollide() {
  const l1 = loadState('l1.json', {});
  const l2 = loadState('l2.json', {});
  const done = loadState('collide.json', {});
  const { model } = makeModel();
  const clusters = [];
  for (let i = 0; i < SCOPE; i += CLUSTER) clusters.push(baseChapters.slice(i, i + CLUSTER));
  return pool(
    clusters,
    CONCURRENCY,
    async (cluster) => {
      const key = `${cluster[0].order}-${cluster.at(-1).order}`;
      if (done[key]) return;
      const l1c = l1[key];
      const l2ev = [];
      for (const ch of cluster) {
        for (const e of l2[String(ch.order)]?.events ?? []) l2ev.push(e);
      }
      const obj = await genJSON({
        model,
        shape: COLLIDE_SHAPE,
        system: '你是结构对账员。判定自底平铺事件能否被自顶骨架事件认领（按剧情内容与章区间判断，标题措辞差异不算不匹配）。',
        prompt:
          `簇 ${key}\n\n【L1 自顶骨架】\n${l1c.events.map((e) => `- ${e.title}（${e.spanFrom}-${e.spanTo}）${e.gist}`).join('\n')}\n\n` +
          `【L2 自底平铺】\n${l2ev.map((e, i) => `${i + 1}. ${e.title}（${e.chapterFrom}-${e.chapterTo}）${e.gist}`).join('\n')}\n\n逐条给出认领判定；再列出空心容器（L1 有而 L2 全无认领的）及疑点猜测。`,
        validate: (o) => ({
          claims: (Array.isArray(o?.claims) ? o.claims : []).map((c) => ({
            l2Title: String(c?.l2Title ?? ''),
            l1Title: c?.l1Title === null || c?.l1Title === 'null' ? null : String(c?.l1Title ?? ''),
            verdict: c?.verdict === 'orphan' ? 'orphan' : 'claimed',
          })),
          hollows: (Array.isArray(o?.hollows) ? o.hollows : []).map((h) => ({ l1Title: String(h?.l1Title ?? ''), suspect: String(h?.suspect ?? '') })),
        }),
      });
      done[key] = obj;
      saveState('collide.json', done);
      console.error(`[collide] 簇 ${key} ✅ orphan=${obj.claims.filter((c) => c.verdict === 'orphan').length} hollow=${obj.hollows.length}`);
    }
  ).then(() => printUsage('collide'));
}

// ============ rank：注意力排序（确定性）→ L3 选章 ============
function cmdRank() {
  const l1 = loadState('l1.json', {});
  const l2 = loadState('l2.json', {});
  const collide = loadState('collide.json', {});
  const L3_RATE = 0.4; // 前 40% 章入选精读（0018：前 30–40% 事件需求驱动，按章折算）
  // 事件级注意力：层级权重(L1 weight) × 承重代理(isPromise×2 或 参与者复现) × 检测器加成(orphan/hollow 簇 ×1.5)
  const chapterScore = new Array(SCOPE + 1).fill(0);
  const hollowClusters = new Set();
  for (const [key, c] of Object.entries(collide)) {
    if ((c.hollows ?? []).length > 0) hollowClusters.add(key);
  }
  const events = [];
  for (const [key, arc] of Object.entries(l1)) {
    for (const e of arc.events) {
      const clusterKey = `${Math.floor((e.spanFrom - 1) / CLUSTER) * CLUSTER + 1}-${Math.min(SCOPE, Math.floor((e.spanFrom - 1) / CLUSTER) * CLUSTER + CLUSTER)}`;
      let score = e.weight;
      if (e.gist.match(/伏笔|承诺|约定|偿还|秘密|暗示/)) score *= 2; // 承重代理：指引性事件
      if (hollowClusters.has(clusterKey)) score *= 1.5; // 检测器加成：疑点簇
      events.push({ ...e, score: Math.round(score * 10) / 10, clusterKey });
    }
  }
  for (const [order, seg] of Object.entries(l2)) {
    for (const e of seg.events) {
      const clusterKey = `${Math.floor((e.chapterFrom - 1) / CLUSTER) * CLUSTER + 1}-${Math.min(SCOPE, Math.floor((e.chapterFrom - 1) / CLUSTER) * CLUSTER + CLUSTER)}`;
      let score = 1;
      if (e.isPromise) score *= 2;
      if (hollowClusters.has(clusterKey)) score *= 1.5;
      events.push({ ...e, spanFrom: e.chapterFrom, spanTo: e.chapterTo, score: Math.round(score * 10) / 10, clusterKey });
    }
  }
  events.sort((a, b) => b.score - a.score);
  // 章级分数=覆盖事件分累计；截前 40%
  for (const e of events) {
    for (let o = e.spanFrom; o <= Math.min(e.spanTo, SCOPE); o++) chapterScore[o] += e.score;
  }
  const ranked = Array.from({ length: SCOPE }, (_, i) => i + 1).sort((a, b) => chapterScore[b] - chapterScore[a]);
  const selected = ranked.slice(0, Math.round(SCOPE * L3_RATE)).sort((a, b) => a - b);
  saveState('rank.json', { events: events.slice(0, 200), chapterScore: chapterScore.slice(1), selected, coverageRate: L3_RATE });
  console.log(`[rank] 事件 ${events.length} 条（L1 ${Object.values(l1).reduce((n, a) => n + a.events.length, 0)} + L2 ${Object.values(l2).reduce((n, s) => n + s.events.length, 0)}）；疑点簇 ${hollowClusters.size}/${Object.keys(l1).length}；L3 选章 ${selected.length}/${SCOPE}`);
}

// ============ L3：需求驱动精读（同基线提示词，写分层账本） ============
const EXTRACT_SHAPE =
  '{"clock":[{"storyDay":"如 第1日:夜","absoluteDate":"公历日期","thread":"主线/支线","notes":""}],"props":[{"name":"道具名","holder":"章末持有者","status":"状态","tripwire":"硬规则","quote":"原文证据短句"}],"promises":[{"name":"伏笔/承诺一句话","arc":"planted|pending|resolved|failed","quote":"原文证据","due":10}],"knowledge":[{"character":"角色","knows":["本章新增已知事实"],"doesNotKnow":["明确未知"]}],"characters":[{"name":"角色","location":"章末位置","alive":"生|死|不明","powerRank":"境界/层级","note":"","quote":""}]}' +
  '（所有数组可为空；只抽正文明确的事实）';
function validateExtract(o) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  const ARCS = ['planted', 'pending', 'resolved', 'failed'];
  return {
    clock: arr(o?.clock).filter((c) => c && typeof c === 'object'),
    props: arr(o?.props).filter((p) => p && typeof p?.name === 'string' && p.name.trim()),
    promises: arr(o?.promises).filter((p) => p && typeof p?.name === 'string' && p.name.trim() && ARCS.includes(p.arc)),
    knowledge: arr(o?.knowledge)
      .filter((k) => k && typeof k.character === 'string' && k.character.trim() && Array.isArray(k.knows))
      .map((k) => ({
        character: k.character,
        knows: arr(k.knows).map((f) => (typeof f === 'string' ? f : typeof f?.fact === 'string' ? f.fact : '')).map((s) => s.trim()).filter(Boolean),
        doesNotKnow: arr(k.doesNotKnow).map((f) => (typeof f === 'string' ? f : typeof f?.fact === 'string' ? f.fact : '')).map((s) => s.trim()).filter(Boolean),
      })),
    characters: arr(o?.characters).filter((c) => c && typeof c.name === 'string' && c.name.trim()),
  };
}
const EXTRACT_SYSTEM =
  '你是网文连续性台账员。从本章正文抽取「跨章需要记住的事实」：时间、道具托管、伏笔埋收、角色知情与角色状态变化。' +
  '只抽正文明确的事实，带原文证据短句；拿不准不抽。' +
  '只收后续章节仍需记住的承重事实：每类数组默认不超过 3 条，仅在确有依据时超出；' +
  '过场打斗、一次性出场、对后文无影响的细节与常识性认知不抽。';

async function extractChapter(model, workDir, ch, progressName) {
  const progress = loadState(progressName, { doneOrders: [] });
  const doneSet = new Set(progress.doneOrders);
  if (doneSet.has(ch.order)) return false;
  try {
    const obj = await genJSON({
      model,
      shape: EXTRACT_SHAPE,
      validate: validateExtract,
      system: EXTRACT_SYSTEM,
      prompt: `章节「${ch.title}」（全书第 ${ch.order} 章）：\n\n${ch.body.slice(0, 8000)}`,
    });
    const ops = [];
    for (const c of obj.clock) ops.push({ op: 'clock', entry: { chapters: [ch.relPath], storyDay: c.storyDay, absoluteDate: c.absoluteDate, thread: c.thread, notes: c.notes } });
    for (const p of obj.props)
      ops.push({ op: 'prop', entry: { name: p.name, holder: p.holder, status: p.status, tripwire: p.tripwire, custody: [{ chapter: ch.relPath, holder: p.holder, quote: p.quote }] } });
    for (const pr of obj.promises) {
      const id = `P-${String(ch.order).padStart(3, '0')}-${ops.length}`;
      const entry = { id, name: pr.name, arc: pr.arc, due: Number.isInteger(pr.due) ? pr.due : undefined, setups: [], payoffs: [] };
      if (pr.arc === 'resolved' || pr.arc === 'failed') entry.payoffs.push({ chapter: ch.relPath, quote: pr.quote });
      else entry.setups.push({ chapter: ch.relPath, quote: pr.quote });
      ops.push({ op: 'promise', entry });
    }
    const cur = readLedger(workDir).ledger;
    for (const k of obj.knowledge) {
      const prev = cur.knowledge.find((e) => e.character === k.character);
      const merged = new Set([...(prev?.knows ?? []).map((f) => (typeof f === 'string' ? f : f.fact)), ...k.knows]);
      ops.push({
        op: 'knowledge',
        entry: { character: k.character, knows: [...merged].map((f) => ({ fact: f, since: ch.relPath })), doesNotKnow: k.doesNotKnow?.map((f) => ({ fact: f, since: ch.relPath })), visibility: prev?.visibility },
      });
    }
    if (ops.length) upsertLedger(workDir, ops);
    // 角色动态变化落 JSONL（与 bench-pipeline 同口径；0905 补——首跑漏落盘为分层臂实现缺口，记档于对照报告）
    if (obj.characters.length) {
      const jl = obj.characters.map((c) => JSON.stringify({ order: ch.order, chapter: ch.relPath, ...c })).join('\n') + '\n';
      fs.appendFileSync(path.join(STATE_DIR, `character-dynamics-分层.jsonl`), jl);
    }
    doneSet.add(ch.order);
    progress.doneOrders = [...doneSet];
    saveState(progressName, progress);
    return true;
  } catch (err) {
    console.error(`[${progressName}] 第 ${ch.order} 章失败，跳过（重跑续补）: ${err.message}`);
    return false;
  }
}

async function cmdL3() {
  const { selected } = loadState('rank.json', {});
  if (!selected) throw new Error('先跑 rank');
  const { model } = makeModel();
  const chapters = selected.map((o) => baseChapters[o - 1]);
  let n = 0;
  let failStreak = 0;
  for (const ch of chapters) {
    const ok = await extractChapter(model, LAYER_WORK, ch, 'l3-progress.json');
    if (ok) { failStreak = 0; n++; if (n % 10 === 0) { console.error(`[l3] ${n}/${chapters.length}`); printUsage('l3'); } }
    else { failStreak++; if (failStreak >= 5) throw new Error('l3 连续 5 章失败，阻塞即停'); }
  }
  printUsage('l3 完成');
  console.log(`[l3] 精读完成：${chapters.length} 章入选（覆盖率台账：其余 ${SCOPE - chapters.length} 章=粗扫态）`);
}

// ============ spotcheck：分层抽样 30 章（地面真值） ============
async function cmdSpotcheck() {
  const { selected } = loadState('rank.json', {});
  const selSet = new Set(selected ?? []);
  const { model } = makeModel();
  // 分层：按密度档（用摘要 tension 作代理分档）×「最长未触及段」（未选入 L3 的章优先）
  const uncovered = baseChapters.filter((c) => !selSet.has(c.order));
  const covered = baseChapters.filter((c) => selSet.has(c.order));
  const pick = (arr, n) => {
    if (arr.length <= n) return arr;
    const step = arr.length / n;
    return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
  };
  const sample = [...pick(uncovered, 20), ...pick(covered, 10)]; // 抽查偏重未精读区（盲区优先）
  const jlPath = stateFile('spotcheck.jsonl');
  const doneOrders = new Set(fs.existsSync(jlPath) ? fs.readFileSync(jlPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).order) : []);
  let n = 0;
  for (const ch of sample) {
    if (doneOrders.has(ch.order)) continue;
    try {
      const obj = await genJSON({
        model,
        shape: EXTRACT_SHAPE,
        validate: validateExtract,
        system: EXTRACT_SYSTEM,
        prompt: `章节「${ch.title}」（全书第 ${ch.order} 章）：\n\n${ch.body.slice(0, 8000)}`,
      });
      const facts = [
        ...obj.props.map((p) => ({ kind: 'prop', name: p.name, detail: `${p.holder}/${p.status}`, quote: p.quote })),
        ...obj.promises.map((p) => ({ kind: 'promise', name: p.name, detail: p.arc, quote: p.quote })),
        ...obj.knowledge.flatMap((k) => k.knows.map((f) => ({ kind: 'knowledge', name: k.character, detail: f }))),
        ...obj.characters.map((c) => ({ kind: 'character', name: c.name, detail: `${c.location}/${c.alive}/${c.powerRank ?? ''}` })),
      ];
      fs.appendFileSync(jlPath, JSON.stringify({ order: ch.order, chapter: ch.relPath, facts }) + '\n');
      doneOrders.add(ch.order);
      n++;
      if (n % 10 === 0) console.error(`[spotcheck] ${n}/${sample.length - [...doneOrders].length + n}`);
    } catch (err) {
      console.error(`[spotcheck] 第 ${ch.order} 章失败，跳过: ${err.message}`);
    }
  }
  printUsage('spotcheck');
  console.log(`[spotcheck] 地面真值 ${doneOrders.size} 章 → ${jlPath}`);
}

// ============ compare：确定性出数 ============
async function cmdCompare() {
  const { reconcileLedger } = await import('../../domain/src/reconcile.js');
  const { ledgerSlice } = await import('../../domain/src/ledger.js');
  const out = { generatedAt: new Date().toISOString(), scope: SCOPE, model: process.env.LLM_MODEL_CHEAP };

  // 成本（各阶段用量快照由调用方记录；此处读 state 内 usage 文件若在）
  const usageSnap = loadState('usage.json', {});
  out.usage = usageSnap;

  // 分层账本密度与精度
  const rec = reconcileLedger(LAYER_WORK);
  const anchors = rec.anchors ?? {};
  const anchorTotal = Object.values(anchors).reduce((n, x) => n + (Array.isArray(x) ? x.length : Number(x) || 0), 0);
  const findings = rec.findings ?? [];
  const findingTypes = {};
  for (const f of findings) findingTypes[f.type ?? f.code ?? '?'] = (findingTypes[f.type ?? f.code ?? '?'] ?? 0) + 1;
  const quoteMissing = findings.filter((f) => String(f.type ?? f.code ?? f.message ?? '').toLowerCase().includes('quote')).length;
  const layerLedger = readLedger(LAYER_WORK).ledger;
  const layerCounts = {
    clock: layerLedger.clock?.length ?? 0,
    props: layerLedger.props?.length ?? 0,
    promises: layerLedger.promises?.length ?? 0,
    knowledge: layerLedger.knowledge?.length ?? 0,
  };
  const l3Sel = loadState('rank.json', {}).selected ?? [];
  out.layered = {
    selectedChapters: l3Sel.length,
    counts: layerCounts,
    totalFacts: Object.values(layerCounts).reduce((a, b) => a + b, 0),
    densityPerSelectedChapter: Math.round((Object.values(layerCounts).reduce((a, b) => a + b, 0) / Math.max(1, l3Sel.length)) * 100) / 100,
    anchorTotal,
    quoteMissing,
    sliceCharsLast: (() => {
      try { return JSON.stringify(ledgerSlice(LAYER_WORK, baseChapters[SCOPE - 1].relPath)).length; } catch { return null; }
    })(),
    findingTypes,
    findingsTotal: findings.length,
  };

  // 基线臂读数（测量报告口径）
  out.baseline = { counts: { clock: 268, props: 759, promises: 1140, knowledge: 262 }, densityPerChapter: 20.19, quoteMissingRate: 0.174, anchorTotal: 6267, calls: 870 };

  // 召回：地面真值事实 vs 两账本（维度内匹配——prop 对 props 名、promise 对 promises 名、knowledge 对 knows 事实子串；
  // character 维分层臂首跑未落盘（实现缺口），如实记不可比）
  const spotPath = stateFile('spotcheck.jsonl');
  const spot = fs.existsSync(spotPath) ? fs.readFileSync(spotPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const baseLedger = readLedger(BASE_WORK).ledger;
  const baseDynamicsPath = path.resolve('.bench/state/character-dynamics-诡秘之主-净本.jsonl');
  const baseDynamics = fs.existsSync(baseDynamicsPath) ? fs.readFileSync(baseDynamicsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const layerDynamicsPath = stateFile('character-dynamics-分层.jsonl');
  const layerDynamics = fs.existsSync(layerDynamicsPath) ? fs.readFileSync(layerDynamicsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const dimHit = (ledger, f, relPath) => {
    // 只认锚在本抽查章的条目（跨章巧合命中不算）——度量语义=同章重合率（两独立抽取的一致性代理）
    if (f.kind === 'knowledge') {
      const core = String(f.detail ?? '').replace(/\s/g, '').slice(0, 10);
      if (core.length < 6) return false;
      for (const k of ledger.knowledge ?? []) for (const kf of k.knows ?? []) {
        const fact = typeof kf === 'string' ? kf : kf.fact ?? '';
        const since = typeof kf === 'string' ? '' : kf.since ?? '';
        if (since && since !== relPath) continue;
        if (fact.includes(core.slice(0, 6)) || core.includes(fact.replace(/\s/g, '').slice(0, 6))) return true;
      }
      return false;
    }
    if (f.kind === 'prop') {
      return (ledger.props ?? []).some((p) => {
        const anchored = (p.custody ?? []).some((c) => c.chapter === relPath) || (p.chapters ?? []).includes(relPath);
        return anchored && (p.name?.includes(f.name) || f.name.includes(p.name ?? '\u0000'));
      });
    }
    if (f.kind === 'promise') {
      const core = f.name.slice(0, 8);
      return (ledger.promises ?? []).some((p) => {
        const anchored = [...(p.setups ?? []), ...(p.payoffs ?? [])].some((x) => x.chapter === relPath);
        return anchored && (p.name?.includes(core) || core.includes(p.name?.slice(0, 8) ?? '\u0000'));
      });
    }
    return false;
  };
  let spotFacts = 0, comparable = 0;
  const hit = { baseline: 0, layered: 0, layeredSel: 0, layeredUnsel: 0 };
  const byKind = { baseline: {}, layered: {} };
  const selSet = new Set(l3Sel);
  for (const row of spot) {
    for (const f of row.facts) {
      spotFacts++;
      if (f.kind === 'character') continue; // 角色维：分层臂首跑未落盘，不可比（记档）
      comparable++;
      if (dimHit(baseLedger, f, row.chapter)) { hit.baseline++; byKind.baseline[f.kind] = (byKind.baseline[f.kind] ?? 0) + 1; }
      if (dimHit(layerLedger, f, row.chapter)) {
        hit.layered++;
        byKind.layered[f.kind] = (byKind.layered[f.kind] ?? 0) + 1;
        if (selSet.has(row.order)) hit.layeredSel++;
        else hit.layeredUnsel++;
      }
    }
  }
  out.recall = { spotChapters: spot.length, spotFacts, comparableFacts: comparable, characterKindExcluded: '分层臂首跑角色动态未落盘（实现缺口，脚本已修供复跑）', baselineHits: hit.baseline, layeredHits: hit.layered, layeredHitsSelected: hit.layeredSel, layeredHitsUnselected: hit.layeredUnsel, baselineRate: comparable ? Math.round((hit.baseline / comparable) * 1000) / 10 : null, layeredRate: comparable ? Math.round((hit.layered / comparable) * 1000) / 10 : null, byKind, baselineDynamicsRows: baseDynamics.length, layeredDynamicsRows: layerDynamics.length };

  // 失控检出（同章确定性一致性检查：同章内「眼眸类名词+色词」两行邻近且色不同）
  const contradictions = [];
  const COLOR_WORDS = /(浅蓝|灰蓝|深蓝|金色|银色|暗红|碧绿|灰白|深灰|漆黑|乌黑|血红|蔚蓝|棕褐|灰色的?眼)/;
  const EYE_WORDS = /(眼眸|双眸|瞳孔|的眼睛|目光|眼瞳)/;
  for (const ch of baseChapters) {
    const lines = ch.body.split('\n');
    const eyeLines = [];
    for (let i = 0; i < lines.length; i++) {
      const color = lines[i].match(COLOR_WORDS)?.[1];
      if (color && EYE_WORDS.test(lines[i])) eyeLines.push({ i, color, text: lines[i].slice(0, 50) });
    }
    for (let a = 0; a < eyeLines.length; a++) {
      for (let b = a + 1; b < eyeLines.length; b++) {
        if (eyeLines[b].i - eyeLines[a].i > 8) break;
        if (eyeLines[a].color === eyeLines[b].color) continue;
        contradictions.push({ order: ch.order, lineA: eyeLines[a].i + 1, lineB: eyeLines[b].i + 1, colors: [eyeLines[a].color, eyeLines[b].color], text: `${eyeLines[a].text} || ${eyeLines[b].text}` });
      }
    }
  }
  out.sameChapterConsistency = { candidates: contradictions.length, samples: contradictions.slice(0, 10), gatekeeperCaught: contradictions.some((c) => c.order === 166 && c.colors.includes('浅蓝') && c.colors.includes('灰蓝')) };
  // 判据注记：实锤 4 条中 3 条在 300 章范围外（辛西娅 622-624 / 乌特拉夫斯基全书 / 安德森窗口>300），范围外不作检出要求
  out.contradictionScope = { inRange: ['守门人眼眸(166)'], outOfRange: ['辛西娅项链(622-624)', '乌特拉夫斯基称谓(全书)', '安德森双自述(窗口>300)'] };

  const outPath = path.resolve('.bench/reports/layered-对照-诡秘之主-净本.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1), 'utf8');
  console.log(JSON.stringify({ layered: out.layered, recall: out.recall, sameChapter: { candidates: out.sameChapterConsistency.candidates, gatekeeper: out.sameChapterConsistency.gatekeeperCaught } }, null, 1));
  console.log(`报告：${outPath}`);
}

const USAGE_STAGE = process.argv[process.argv.indexOf('--stage') + 1];
function snapUsage(stage) {
  const u = loadState('usage.json', {});
  u[stage] = { calls: usage.calls, input: usage.input, output: usage.output };
  saveState('usage.json', u);
}

const cmds = { setup: cmdSetup, l1: cmdL1, l2: cmdL2, collide: cmdCollide, rank: cmdRank, l3: cmdL3, spotcheck: cmdSpotcheck, compare: cmdCompare };
if (!cmds[cmd]) {
  console.error('用法：node scripts/bench/layered-pipeline.mjs <setup|l1|l2|collide|rank|l3|spotcheck|compare> [--concurrency 3] [--stage 名]');
  process.exit(2);
}
await cmds[cmd]();
if (USAGE_STAGE) snapUsage(USAGE_STAGE);
