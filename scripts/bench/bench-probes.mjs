#!/usr/bin/env node
// scripts/bench/bench-probes.mjs —— LLM 采样探针（试车台批；免费档；全部可断点重跑）。
//
// 子命令：
//   state          角色状态变化分析（读 state/character-dynamics.jsonl，零 LLM：频率/动静态分布）
//   density        漏登记密度分析（读仪器账本+动态 jsonl，零 LLM：每章各维事实密度分布）
//   contradiction  失控实证扫描（LLM：章节窗口内跨章矛盾检测，带证据锚；零记录也是证据）
//   continuation   盖真章续写对比（LLM：摘要链+上一章全文续写 vs 真章——声口偏离确定性测量+情节吻合 judge）
//
// 用法：
//   node scripts/bench/bench-probes.mjs state|density --work .bench/work/十日终焉
//   node scripts/bench/bench-probes.mjs contradiction --work .bench/work/十日终焉 [--window 5]
//   node scripts/bench/bench-probes.mjs continuation --work .bench/work/十日终焉 [--orders 5,6,7,8,9,10]
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
  console.error('用法：node scripts/bench/bench-probes.mjs <state|density|contradiction|continuation> --work <工作区> [--window N] [--orders 5,6,7]');
  process.exit(2);
}
const chapters = readChapters(path.join(workDir, 'manuscript')).slice(0, Number(flagVal('--limit', 1e9)));
const stateDir = path.join(workDir, '..', '..', 'state');
const bookTag = path.basename(workDir); // 产物按书后缀，防跨书覆盖（与 bench-pipeline 状态隔离同口径）
const outDir = flagVal('--out', '.bench/reports');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

const { register } = await import('tsx/esm/api');
register();

// ================= state / density（零 LLM，读仪器产物） =================
function runState() {
  const jl = path.join(stateDir, `character-dynamics-${bookTag}.jsonl`);
  if (!fs.existsSync(jl)) throw new Error(`无 character-dynamics-${bookTag}.jsonl——先跑 bench-pipeline ledger`);
  const rows = fs.readFileSync(jl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const byChar = new Map();
  for (const r of rows) {
    if (!byChar.has(r.name)) byChar.set(r.name, []);
    byChar.get(r.name).push(r);
  }
  const fieldFill = { location: 0, alive: 0, powerRank: 0, note: 0, quote: 0 };
  for (const r of rows) for (const k of Object.keys(fieldFill)) if (r[k]) fieldFill[k]++;
  const out = {
    generatedAt: new Date().toISOString(),
    chapters: chapters.length,
    dynamicsRows: rows.length,
    perChapterMean: Math.round((rows.length / Math.max(1, chapters.length)) * 100) / 100,
    characters: [...byChar.entries()]
      .map(([name, rs]) => ({ name, changes: rs.length, firstOrder: Math.min(...rs.map((r) => r.order)), lastOrder: Math.max(...rs.map((r) => r.order)) }))
      .sort((a, b) => b.changes - a.changes),
    fieldFill,
  };
  fs.writeFileSync(path.join(outDir, `probe-state-${bookTag}.json`), JSON.stringify(out, null, 1), 'utf8');
  console.log(`角色状态变化 ${rows.length} 条 / ${chapters.length} 章 = ${out.perChapterMean} 条/章；角色 ${byChar.size} 个`);
  console.log(`字段填充率：${JSON.stringify(fieldFill)}`);
  console.log('变化最多角色：', out.characters.slice(0, 8).map((c) => `${c.name}×${c.changes}`).join(' '));
}

async function runDensity() {
  const { readLedger } = await import('../../domain/src/ledger.js');
  const { ledger } = readLedger(workDir);
  const perChapter = new Map(); // order -> {clock, props, promises, knowledge, total}
  const bump = (relPath, dim) => {
    const ch = chapters.find((c) => c.relPath === relPath);
    if (!ch) return;
    if (!perChapter.has(ch.order)) perChapter.set(ch.order, { clock: 0, props: 0, promises: 0, knowledge: 0, total: 0 });
    perChapter.get(ch.order)[dim]++;
    perChapter.get(ch.order).total++;
  };
  for (const c of ledger.clock) for (const rp of c.chapters) bump(rp, 'clock');
  for (const p of ledger.props) for (const s of p.custody) bump(s.chapter, 'props');
  for (const p of ledger.promises) {
    for (const s of p.setups) bump(s.chapter, 'promises');
    for (const s of p.payoffs) bump(s.chapter, 'promises');
  }
  for (const k of ledger.knowledge) for (const f of k.knows) if (f.since) bump(f.since, 'knowledge');
  const rows = [...perChapter.entries()].sort((a, b) => a[0] - b[0]).map(([order, d]) => ({ order, ...d }));
  const mean = rows.length ? rows.reduce((s, r) => s + r.total, 0) / rows.length : 0;
  const out = {
    generatedAt: new Date().toISOString(),
    chapters: chapters.length,
    ledgerTotals: { clock: ledger.clock.length, props: ledger.props.length, promises: ledger.promises.length, knowledge: ledger.knowledge.length },
    perChapter,
    perChapterRows: rows,
    factsPerChapterMean: Math.round(mean * 100) / 100,
  };
  out.perChapter = undefined; // Map 不进 JSON
  fs.writeFileSync(path.join(outDir, `probe-density-${bookTag}.json`), JSON.stringify(out, null, 1), 'utf8');
  console.log(`账本条目：clock ${ledger.clock.length} / props ${ledger.props.length} / promises ${ledger.promises.length} / knowledge ${ledger.knowledge.length}`);
  console.log(`每章事实密度均值 ${out.factsPerChapterMean}（${chapters.length} 章）`);
}

// ================= contradiction（LLM，失控实证扫描） =================
// CONTRA_SHAPE/excluded：0830 裁决四类失败模式回灌——同场景多物并读、预设词（「提前」类）误判、
// 时间推进/知情差异可解释、引文意译不可定位。excluded 字段强制报前自检，quote 纪律=逐字摘抄。
const CONTRA_SHAPE =
  '{"contradictions":[{"desc":"矛盾描述","type":"时空|生死|道具|设定|知情|其他","chapterA":"第N章","quoteA":"原文逐字证据A","chapterB":"第M章","quoteB":"原文逐字证据B","confidence":"高|中|低","excluded":"报前已排除的合理解释（时间推进/视角或知情差异/同场景多物/角色言语不实/预设词误读），无则填无"}]}（无矛盾给空数组；quote 必须逐字摘抄原句禁止意译；只报跨章事实冲突，带双锚；人物主观感受/风格问题不算）';
async function runContradiction() {
  const window = Number(flagVal('--window', 5));
  const { model } = makeModel();
  const all = [];
  const failedWindows = []; // 逐窗容错：单窗失败跳过（重跑续补），不炸全程
  for (let i = 0; i < chapters.length; i += window) {
    const win = chapters.slice(i, i + window);
    const material = win.map((c) => `=== ${c.title}（第${c.order}章）===\n${c.body.slice(0, 6000)}`).join('\n\n');
    let obj;
    try {
      obj = await genJSON({
        model,
        shape: CONTRA_SHAPE,
        validate: (o) => ({ contradictions: Array.isArray(o?.contradictions) ? o.contradictions : [] }),
        system:
          '你是长篇连续性审校员。在给出的连续章节中找跨章事实矛盾：同一事实两处说法冲突（位置/生死/道具归属/时间线/设定/谁知情）。' +
          '判别纪律：①quote 必须逐字摘抄原文，禁止意译改写；②同一场景先后出现多件物品/多个人物不是矛盾，除非文中明确它们指同一物；' +
          '③后文出现「提前」「已经」「再次」等预设词时，先到前文核实该前提是否真的不存在，找不到前提才报；' +
          '④时间推进、视角或知情差异、角色撒谎或口误都能化解的说法冲突不算矛盾，报前自行排除并在 excluded 写明。' +
          '宁缺毋滥，只报双锚齐全且无法用上述解释化解的。',
        prompt: material,
      });
    } catch (err) {
      failedWindows.push(`${win[0].order}-${win.at(-1).order}`);
      console.error(`[contradiction] 窗口 ${win[0].order}-${win.at(-1).order} 失败跳过（重跑续补）: ${err.message}`);
      continue;
    }
    for (const c of obj.contradictions) all.push({ window: `${win[0].order}-${win.at(-1).order}`, ...c });
    console.error(`[contradiction] 窗口 ${win[0].order}-${win.at(-1).order}：${obj.contradictions.length} 条`);
  }
  fs.writeFileSync(
    path.join(outDir, `probe-contradiction-${bookTag}.json`),
    JSON.stringify({ generatedAt: new Date().toISOString(), chapters: chapters.length, window, failedWindows, contradictions: all }, null, 1),
    'utf8',
  );
  console.log(`失控实证：${all.length} 条（窗口 ${window} 章 × ${Math.ceil(chapters.length / window)} 个，失败窗 ${failedWindows.length}）`);
  all.slice(0, 5).forEach((c) => console.log(`  [${c.confidence}] ${c.desc}（${c.chapterA} vs ${c.chapterB}）`));
  printUsage('contradiction');
}

// ================= continuation（盖真章续写对比） =================
const JUDGE_SHAPE = '{"plotFit":0到5整数,"canonClash":0到5整数,"voiceFit":0到5整数,"reason":"一句话"}（plotFit=与真章情节走向吻合度；canonClash=与既有设定的矛盾程度，5=零矛盾；voiceFit=声口贴近度）';
async function runContinuation() {
  const orders = String(flagVal('--orders', ''))
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean);
  const targets = orders.length ? chapters.filter((c) => orders.includes(c.order)) : chapters.slice(4, 9);
  if (!targets.length) throw new Error('无目标章：--orders 1,2,3');
  const { model } = makeModel();
  const { readChapterSummaries } = await import('../../domain/src/summaries.js');
  const { voiceMetrics, compareVoice } = await import('../../domain/src/voice.js');
  const rows = [];
  for (const ch of targets) { try {
    // 摘要链（滚动前 10 章有摘要的）+ 上一章全文 = 裸上下文口径（报告注明：不测 core 正式注入）
    const summaries = readChapterSummaries(workDir, undefined, { before: ch.relPath, limit: 10 }).summaries;
    const prev = chapters.find((c) => c.order === ch.order - 1);
    const summaryChain = summaries.map((s) => `【${s.relPath.split('/').pop()}】${s.summary}`).join('\n');
    const gen = await genJSON({
      model,
      shape: '{"text":"续写正文 400-600 字"}',
      validate: (o) => {
        const t = String(o?.text ?? '').trim();
        if (t.length < 100) throw new Error('续写过短');
        return { text: t };
      },
      system: '你是网文续写员。根据摘要链与上一章全文，续写下一章开头。忠实既有设定与声口，不造新设定。',
      prompt: `【摘要链】\n${summaryChain || '（无）'}\n\n【上一章「${prev?.title ?? ''}」全文】\n${prev?.body.slice(0, 6000) ?? '（无）'}\n\n请续写「${ch.title}」的开头（不要写章标题）。`,
      temperature: 0.5,
    });
    // 确定性半：声口偏离（基线=前三章合并，产出=续写段）
    const baseBody = chapters
      .filter((c) => c.order < ch.order)
      .slice(-3)
      .map((c) => c.body)
      .join('\n\n');
    const deviation = compareVoice(voiceMetrics('base', baseBody), voiceMetrics('gen', gen.text));
    // LLM judge：续写 vs 真章
    const judge = await genJSON({
      model,
      shape: JUDGE_SHAPE,
      validate: (o) => ({
        plotFit: Math.max(0, Math.min(5, Math.round(Number(o?.plotFit) || 0))),
        canonClash: Math.max(0, Math.min(5, Math.round(Number(o?.canonClash) || 0))),
        voiceFit: Math.max(0, Math.min(5, Math.round(Number(o?.voiceFit) || 0))),
        reason: String(o?.reason ?? ''),
      }),
      system: '你是严苛的网文编辑。对比 AI 续写与真实原文，打分并给一句理由。',
      prompt: `【真实第${ch.order}章「${ch.title}」开头】\n${ch.body.slice(0, 1500)}\n\n【AI 续写】\n${gen.text}`,
    });
    rows.push({ order: ch.order, title: ch.title, genChars: gen.text.length, voiceFlags: deviation.flags, deltas: deviation.deltas, judge });
    console.error(`[continuation] 第${ch.order}章：plotFit=${judge.plotFit} canonClash=${judge.canonClash} voiceFit=${judge.voiceFit} 声口偏离flags=${deviation.flags.length}`);
  } catch (err) {
    rows.push({ order: ch.order, title: ch.title, error: String(err?.message ?? err).slice(0, 200) }); // 逐点容错：单点失败记档不炸全程
    console.error(`[continuation] 第${ch.order}章失败跳过（重跑续补）: ${err.message}`);
  } }
  const scored = rows.filter((r) => r.judge);
  const mean = (k) => Math.round((scored.reduce((s, r) => s + r.judge[k], 0) / Math.max(1, scored.length)) * 100) / 100;
  const out = { generatedAt: new Date().toISOString(), workDir, targets: rows, means: { plotFit: mean('plotFit'), canonClash: mean('canonClash'), voiceFit: mean('voiceFit') } };
  fs.writeFileSync(path.join(outDir, `probe-continuation-${bookTag}.json`), JSON.stringify(out, null, 1), 'utf8');
  console.log(`盖真章续写 ${scored.length} 章：均值 plotFit=${out.means.plotFit} canonClash=${out.means.canonClash} voiceFit=${out.means.voiceFit}`);
  printUsage('continuation');
}

if (cmd === 'state') runState();
else if (cmd === 'density') await runDensity();
else if (cmd === 'contradiction') await runContradiction();
else if (cmd === 'continuation') await runContinuation();
else {
  console.error(`未知子命令：${cmd}`);
  process.exit(2);
}
