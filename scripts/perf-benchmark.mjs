#!/usr/bin/env node
// scripts/perf-benchmark.mjs —— 长篇性能基准（独立脚本：不进 CI、不进 npm test，手动跑）。
// 用法：node scripts/perf-benchmark.mjs
// 做法：在临时目录合成书籍（100 章×3000 字 / 300 章×3000 字 两档，可重复伪随机中文文本），
// 直接调用 domain/src 的工具实现（经 tsx ESM register 加载 TS 源），对 scan_quality /
// word_count / search_content / diagnostics 各计时，输出表格（工具 × 档位 × 耗时 × 峰值内存）。
// 计时在独立子进程里做（每格一格）：sync 工具会阻塞事件循环，进程级 RSS 才能近似峰值内存，
// 且互不污染（前一格的全量驻留不会算进后一格）。数字受机器状态影响，只看量级与相对关系。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

const TIERS = [
  { chapters: 100, charsPerChapter: 3000 },
  { chapters: 300, charsPerChapter: 3000 },
];
const TOOLS = ['scan_quality', 'word_count', 'search_content', 'diagnostics'];
const RUNS = Number(process.env.PERF_RUNS ?? 3); // 每格计时轮数（另加 1 轮 warmup）
const SEARCH_QUERY = '剑光';
const SEARCH_LIMIT = 20;

// ---------- 子测量进程入口（MEASURE_TOOL 在位时只跑单工具计时并输出一行 JSON） ----------

if (process.env.MEASURE_TOOL) {
  await runMeasure();
}

async function runMeasure() {
  // domain/src 是 TypeScript，借 workspace 内的 tsx 做 ESM 加载（devDependency 已提升到根 node_modules）。
  const { register } = await import('tsx/esm/api');
  register();
  const workDir = process.env.MEASURE_WORK;
  const tool = process.env.MEASURE_TOOL;
  const { scanQuality, searchContent, wordCount } = await import('../domain/src/tools.js');
  const { diagnosticsForWork } = await import('../domain/src/ledger.js');
  const impls = {
    scan_quality: () => scanQuality(workDir),
    word_count: () => wordCount(workDir),
    search_content: () => searchContent(workDir, SEARCH_QUERY, SEARCH_LIMIT),
    diagnostics: () => diagnosticsForWork(workDir),
  };
  const fn = impls[tool];
  if (!fn) throw new Error(`perf-benchmark 未知工具: ${tool}`);
  fn(); // warmup：含模块惰性初始化与首次磁盘读，不计入
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
  const median = times[Math.floor(times.length / 2)] ?? NaN;
  const mb = (x) => Math.round(x / (1024 * 1024) * 10) / 10;
  process.stdout.write(
    JSON.stringify({ tool, medianMs: Math.round(median), rssBaseMB: mb(base), rssPeakMB: mb(peak), runs: RUNS }),
  );
}

// ---------- 主流程：合成书籍 → 逐格子进程测量 → 打表 ----------

/** 可重复伪随机（mulberry32）：同 seed 同书，保证两档/多次运行口径一致。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 常用汉字池（够生成 3000 字/章的正文即可，无文学性要求）。 */
const CHAR_POOL =
  '的一是了我不人在他有这上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感见明问力理尔点文几定本公特做外孩相西果走将月十实向声车全信重三机工物气每并别真打太新比才便夫再书部水像眼等体却加电主界门利海受听表德少克代员许稜先口由死安写性马光白或住难望教命花结乐色更拉东神记处让母父应直字场平报友关放至张认接告入笑内英军候民岁往何度山觉路带万男边风解叫任金快原吃妈变通师立象数四失满战远格士音轻目条呢病始达深完今提求清王化空业思切怎非找片罗钱吗语元喜曾离飞科言干流欢约各即指合反题必该论交终林请医晚制球决传画保读运及则房早院量苦火布品近坐产答星精视五连司巴奇管类未朋且婚台夜青北队久乎越观落尽形影红爸百令周吧识步希亚术留市半热送兴造谈容极随演收首根讲整式取照办强石古华拿计您装似足双妻尼转诉米称丽客南领节衣站黑刻统断福城故历惊脸选包紧争另建维绝树系伤示愿持千史谁准联妇纪基买志静阿诗独复痛消社算义竟确酒需单治卡幸兰念举仅钟怕共毛句息功官待究跟穿室易游程号居考突皮哪费倒价图具刚脑永歌响商礼细专黄块脚味灵改据般破引食仍存众注笔甚某沉血备习校默务土微娘试背料注广坚善借苏赖虽拍累暗农岛针称乐判盐协私效援审收犯距抗府坛税备追质显剧据宣环谋茶斗斗兰铁雷席辩脑速构岗革票宪环剑光屋脊客栈木门推刀鞘雪夜檐灯巷口渡桥镇集';

/** 合成一章：frontmatter + 一个场景标题 + 约 targetChars 字伪随机正文（固定插入含「剑光」的句子供搜索命中）。 */
function makeChapter(rng, no, targetChars) {
  const parts = [];
  let len = 0;
  while (len < targetChars) {
    const sentenceLen = 8 + Math.floor(rng() * 18);
    let sentence = '';
    for (let i = 0; i < sentenceLen; i++) sentence += CHAR_POOL[Math.floor(rng() * CHAR_POOL.length)];
    if (Math.floor(rng() * 8) === 0) sentence = `一道${SEARCH_QUERY}掠过屋脊，惊起檐下宿鸟`;
    else if (Math.floor(rng() * 12) === 0) sentence = `「${sentence.slice(0, 6)}」，他推开客栈的木门说道`;
    parts.push(`${sentence}。`);
    len += sentence.length + 1;
    if (Math.floor(rng() * 4) === 0 || len >= targetChars) parts.push('\n\n');
  }
  const body = parts.join('').replace(/\n\n$/, '');
  return [
    '---',
    `title: 第${no}章·试炼`,
    'status: draft',
    '---',
    '',
    `### 场景·${CHAR_POOL.slice(Math.floor(rng() * 100), Math.floor(rng() * 100) + 2)}`,
    '',
    body,
    '',
  ].join('\n');
}

/** 在临时目录合成一本书：manuscript/<卷>/第N章.md，每 100 章一卷。返回 { dir, cleanup }。 */
function synthesizeBook({ chapters, charsPerChapter }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-perf-'));
  fs.mkdirSync(path.join(dir, 'manuscript'), { recursive: true });
  const rng = mulberry32(20260822);
  for (let no = 1; no <= chapters; no++) {
    const volNo = Math.floor((no - 1) / 100) + 1;
    const vol = path.join(dir, 'manuscript', `第${volNo}卷·风起`);
    fs.mkdirSync(vol, { recursive: true });
    fs.writeFileSync(path.join(vol, `第${no}章.md`), makeChapter(rng, no, charsPerChapter), 'utf8');
  }
  return {
    dir,
    label: `${chapters}章×${charsPerChapter}字`,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function main() {
  console.log(`domain 长篇性能基准（每格 warmup 1 + 计时 ${RUNS} 轮取中位；峰值内存=子进程 RSS 峰值）\n`);
  const rows = [];
  for (const tier of TIERS) {
    const book = synthesizeBook(tier);
    try {
      for (const tool of TOOLS) {
        const res = measureInChild(tool, book.dir);
        rows.push({ tool, tier: book.label, ...res });
      }
    } finally {
      book.cleanup();
    }
  }

  // 打表：工具 × 档位 × 耗时 × 峰值内存
  const wTool = Math.max(...rows.map((r) => r.tool.length));
  const wTier = Math.max(...rows.map((r) => r.tier.length), '档位'.length);
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
  console.log(`${pad('工具', wTool)}  ${pad('档位', wTier)}  中位耗时     RSS基线     RSS峰值     净增内存`);
  console.log('-'.repeat(wTool + wTier + 56));
  for (const r of rows) {
    const deltaMB = Math.round((r.rssPeakMB - r.rssBaseMB) * 10) / 10;
    console.log(
      `${pad(r.tool, wTool)}  ${pad(r.tier, wTier)}  ${pad(`${r.medianMs} ms`, 10)}  ${pad(`${r.rssBaseMB} MB`, 10)}  ${pad(`${r.rssPeakMB} MB`, 10)}  ${deltaMB} MB`,
    );
  }
}

/** 起子进程测单格：--expose-gc 让 warmup 后可回收，stdout 只承载一行 JSON 结果。 */
function measureInChild(tool, workDir) {
  const res = spawnSync(process.execPath, ['--expose-gc', SELF], {
    cwd: HERE,
    env: { ...process.env, MEASURE_TOOL: tool, MEASURE_WORK: workDir },
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`perf-benchmark 子进程失败（${tool}）:\n${res.stderr}`);
  }
  const line = res.stdout.trim().split(/\r?\n/).pop();
  return JSON.parse(line);
}

// 主流程入口放文件末尾（避免 TDZ：顶层 await 先于下方 const 声明执行）
if (!process.env.MEASURE_TOOL) {
  await main();
}
