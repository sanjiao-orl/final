#!/usr/bin/env node
/**
 * name-census.mjs —— 语料人名/称谓确定性普查（试车台批，零 LLM）
 *
 * 喂 0017 仪器①⑤：中文「名/字/绰号/称谓」归一的行业空白（外-a3）需要真实数据。
 * 方法（2026-08-28 实测网文语料校准）：网文归属极简（齐夏×138 而「齐夏说」几乎为零），
 * 主角名以叙事主语形态出现，故主抽取器=**句首 2–4 字词频挖掘**，辅抽取器=引号后归属/称谓后缀。
 * 产出：
 * - 候选人名清单（频次≥--min-count，默认 5）
 * - 别名谱：包含关系/编辑距离 1 聚类（同一角色的多种写法）
 * - 称谓不一致嫌疑：低频（1–2 次）且与高频名编辑距离 1 的写法（疑似错字/一次性称呼，人审）
 * - 人名随章分布（前 20 名逐章提及数）
 * 局限：句首挖掘会漏纯宾语态角色、混入高频非人名词（stoplist 压制但不为零）——仪器非产品，人读报告时自有判断。
 *
 * 用法：node scripts/bench/name-census.mjs <manuscriptRoot> [--min-count 5] [--out .bench/reports]
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const root = args[0];
if (!root) {
  console.error('用法：node scripts/bench/name-census.mjs <manuscriptRoot> [--min-count 5] [--out .bench/reports]');
  process.exit(2);
}
const flagVal = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const MIN_COUNT = Number(flagVal('--min-count', 5));
const outDir = flagVal('--out', '.bench/reports');

// ---- 读章（按 fm order 排序）----
function readChapters(dir) {
  const out = [];
  for (const vol of fs.readdirSync(dir)) {
    const vdir = path.join(dir, vol);
    if (!fs.statSync(vdir).isDirectory()) continue;
    for (const f of fs.readdirSync(vdir)) {
      if (!f.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(vdir, f), 'utf8');
      const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      const fm = fmMatch ? fmMatch[1] : '';
      const order = Number(fm.match(/^order:\s*(\d+)/m)?.[1] ?? 0);
      const title = fm.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? f.replace(/\.md$/, '');
      const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
      out.push({ order, title, volume: vol, body });
    }
  }
  return out.sort((a, b) => a.order - b.order);
}

// 句首词挖掘：。！？…— 换行 」 之后的整段 CJK 连跑，对其 2/3/4 字前缀全部计数
// （固定长度贪心会把「齐夏又看」吞成单一 token；前缀计数让词干「齐夏」自然浮顶）
const SUBJECT_RUN = /(?:^|[。！？…—\n」])([一-鿿]+)/gm;
// 引号后归属：」齐夏说 / 」乔家劲问道
const POST_QUOTE = /」\s*([一-鿿]{2,4})(?=说|道|问|答|喊|叫|骂|笑|叹|喃喃|嘀咕|自语|开口)/g;
// 称谓后缀：林师兄 / 乔队长 / 齐先生（主干 1–2 字也记）
const HONORIFIC = /([一-鿿]{1,2})(师兄|师姐|师弟|师妹|前辈|道友|大人|公子|姑娘|小姐|先生|长老|门主|帮主|楼主|阁主|谷主|岛主|尊者|真人|圣子|圣女|施主|居士|大哥|二哥|三哥|大姐|二姐|老板|队长|首领|盟主|掌门|师父|师尊|徒弟|陛下|殿下|王爷|将军|少主|家主|族长|院长|校长|所长|博士|警官|医生|老师)/g;

// 高频非人名排除（句首常见词/代词/叙事套语）
const STOP = new Set((
  '这时 此时 此刻 这一 那一 下一 上一 随后 随即 很快 只见 突然 忽然 顿时 同时 然而 但是 可是 只是 如果 因为 所以 虽然 尽管 于是 接着 然后 现在 刚才 方才 之前 之后 一边 不远 黑暗 空气 房间 屋子 走廊 街道 城市 世界 人们 事情 东西 问题 情况 时间 地方 声音 眼神 表情 动作 身体 大脑 心脏 目光 视线 呼吸 心跳 意识 记忆 感觉 感受 想法 念头 思绪 情绪 气氛 环境 周围 附近 前方 身后 头顶 脚下 手里 手中 眼前 耳边 嘴角 脸上 面色 脸色 神色 语气 话音 说完 想到 听到 看到 知道 觉得 感觉 没有 不是 就是 还是 已经 正在 怎么 什么 一个 这个 那个 这样 那样 他们 我们 你们 大家 众人 有人 别人 所有 自己 对方 身旁 旁边 一旁 对面 背后 低头 抬头 抬起 放下 伸出 收回 转身 转过 站起 坐下 蹲下 缓缓 慢慢 轻轻 重重 死死 默默 静静 淡淡 冷冷 微微 稍稍 略略 渐渐 逐渐 不断 不停 继续 开始 仿佛 似乎 好像 像是 如同 宛如 犹如 就像 即便 即使 哪怕 虽然 与其 不如 不管 无论 究竟 到底 难道 莫非 恐怕 或许 也许 大概 可能 应该 竟然 果然 显然 明显 反而 反倒 偏偏 恰巧 正好 恰好 刚好 先前 随后 紧跟着 下一刻 下一秒 一瞬间 眨眼间 转眼间 说话间 片刻后 半晌 良久 许久 须臾 与此同时 与此 与此同'
).split(/\s+/));
// 代词与通用指称（2–4 字句首高频）
for (const w of ['他', '她', '我', '你', '它', '您', '谁', '啥', '咋']) STOP.add(w);
for (const w of ['他的', '她的', '我的', '你的', '它的', '在这', '在那', '毕竟', '只有', '众人听', '健硕', '于是说', '就这么', '就这点', '这一下', '下一秒', '下一刻']) STOP.add(w);

function mine(chapters) {
  const forms = new Map(); // name -> { count, perChapter: Map, sources: Set }
  const bump = (name, chIdx, src) => {
    if (!name || name.length < 2 || name.length > 4) return;
    if (STOP.has(name)) return;
    let rec = forms.get(name);
    if (!rec) {
      rec = { count: 0, perChapter: new Map(), sources: new Set() };
      forms.set(name, rec);
    }
    rec.count++;
    rec.sources.add(src);
    rec.perChapter.set(chIdx, (rec.perChapter.get(chIdx) ?? 0) + 1);
  };
  chapters.forEach((ch, idx) => {
    let m;
    SUBJECT_RUN.lastIndex = 0;
    while ((m = SUBJECT_RUN.exec(ch.body)) !== null) {
      const run = m[1];
      for (let len = 2; len <= Math.min(4, run.length); len++) bump(run.slice(0, len), idx, '句首');
    }
    POST_QUOTE.lastIndex = 0;
    while ((m = POST_QUOTE.exec(ch.body)) !== null) bump(m[1], idx, '归属');
    HONORIFIC.lastIndex = 0;
    while ((m = HONORIFIC.exec(ch.body)) !== null) {
      bump(m[1], idx, '称谓');
      bump(m[1] + m[2], idx, '称谓形');
    }
  });
  return forms;
}

/** 词干吸收：候选 B 若存在真前缀 A 也是候选且 A.count ≥ B.count × 3（强支配），则 B 是「名字+动词尾巴」噪音，压掉。
 *  （阈值 3 的理由：前缀计数天然膨胀——克莱恩 3639 次出现必然同时给 克莱 +3639，
 *   真名比 ≈2:1 会被误压；噪音尾巴如 齐夏又 的比例则 >10:1。） */
function suppressNonStem(forms) {
  const names = [...forms.keys()];
  const drop = new Set();
  for (const b of names) {
    for (let len = 2; len < b.length; len++) {
      const a = b.slice(0, len);
      const ra = forms.get(a);
      const rb = forms.get(b);
      if (ra && rb && ra.count >= rb.count * 3 && ra.count >= 3) {
        drop.add(b);
        break;
      }
    }
  }
  for (const b of drop) forms.delete(b);
  return forms;
}

const chapters = readChapters(root);
console.error(`读入 ${chapters.length} 章（${root}）`);
const forms = suppressNonStem(mine(chapters));

const all = [...forms.entries()].map(([name, r]) => ({ name, ...r }));
const names = all.filter((r) => r.count >= MIN_COUNT).sort((a, b) => b.count - a.count);
const rare = all.filter((r) => r.count >= 2 && r.count < MIN_COUNT);

// ---- 别名聚类：包含关系 或 同长编辑距离 1（高频集合内并查集）----
function editDist1(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
  return diff === 1;
}
const parent = new Map(names.map((n) => [n.name, n.name]));
const find = (x) => {
  while (parent.get(x) !== x) {
    parent.set(x, parent.get(parent.get(x)));
    x = parent.get(x);
  }
  return x;
};
const union = (a, b) => parent.set(find(a), find(b));
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const a = names[i].name;
    const b = names[j].name;
    if (Math.abs(a.length - b.length) > 2) continue;
    const contained = a.length !== b.length && (a.includes(b) || b.includes(a));
    if (contained || editDist1(a, b)) union(a, b);
  }
}
const clusters = new Map();
for (const n of names) {
  const k = find(n.name);
  if (!clusters.has(k)) clusters.set(k, []);
  clusters.get(k).push({ name: n.name, count: n.count, sources: [...n.sources] });
}
const clusterList = [...clusters.values()]
  .filter((c) => c.length > 1)
  .map((c) => c.sort((x, y) => y.count - x.count))
  .sort((a, b) => b[0].count - a[0].count);

// ---- 不一致嫌疑：低频形（2 次到阈值以下）与高频形（≥max(20, 阈值×4)）编辑距离 1 ----
const HI = Math.max(20, MIN_COUNT * 4);
const frequent = names.filter((n) => n.count >= HI);
const suspects = [];
for (const r of rare) {
  for (const h of frequent) {
    if (editDist1(r.name, h.name) || (r.name.length === h.name.length + 1 && r.name.includes(h.name))) {
      suspects.push({ rare: r.name, rareCount: r.count, likely: h.name, likelyCount: h.count });
      break;
    }
  }
}

// ---- 人名随章分布（前 20 名）----
const top20 = names.slice(0, 20).map((n) => ({
  name: n.name,
  total: n.count,
  firstSeen: Math.min(...n.perChapter.keys()) + 1,
  lastSeen: Math.max(...n.perChapter.keys()) + 1,
  chaptersActive: n.perChapter.size,
  perChapter: chapters.map((_, i) => n.perChapter.get(i) ?? 0),
}));

const report = {
  generatedAt: new Date().toISOString(),
  corpus: { root, chapters: chapters.length, minCount: MIN_COUNT },
  totals: { candidates: all.length, frequent: names.length, rare: rare.length, clusters: clusterList.length, suspects: suspects.length },
  topNames: names.slice(0, 50).map((n) => ({ name: n.name, count: n.count, sources: [...n.sources] })),
  aliasClusters: clusterList.slice(0, 40),
  suspects: suspects.slice(0, 100),
  top20PerChapter: top20,
};
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'name-census.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 1), 'utf8');

console.log(`候选 ${all.length}（高频≥${MIN_COUNT}: ${names.length}，低频: ${rare.length}）`);
console.log(`别名聚类 ${clusterList.length} 组；不一致嫌疑 ${suspects.length} 条`);
console.log('\n前 20 候选：');
names.slice(0, 20).forEach((n, i) => console.log(`  ${String(i + 1).padStart(2)}. ${n.name} ×${n.count}（${[...n.sources].join('/')}）`));
console.log('\n前 10 别名聚类：');
clusterList.slice(0, 10).forEach((c) => console.log(`  ${c.map((x) => `${x.name}×${x.count}`).join(' / ')}`));
console.log(`\n报告：${outPath}`);
