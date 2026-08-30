#!/usr/bin/env node
// scripts/bench/hetushu-materialize.mjs —— raw chunks.jsonl → 工作区 manuscript（试车台批语料管道）。
//
// 分层（0830 机制审计后定形）：
//   不变量进代码（与站点无关，防再发）：URL 去重 + order 重排、内容哈希去重、水印残留 QA、保真度分布、净本报告；
//   站点差异进数据（--profile，换站=换 JSON 不改代码）：水印 pattern 集、阅读器 UI 行集、全角归一开关；
//   对抗变化进 QA 门（站点轮换水印/改版时在此暴露，而非静默污染语料）。
//
// 用法：node scripts/bench/hetushu-materialize.mjs [--raw .bench/raw/诡秘之主] [--work .bench/work/诡秘之主-净本]
//        [--profile scripts/bench/site-profiles/hetushu.json]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const flagVal = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const rawDir = flagVal('--raw', '.bench/raw/诡秘之主');
const workDir = flagVal('--work', '.bench/work/诡秘之主-净本');
const profileFile = flagVal('--profile', 'scripts/bench/site-profiles/hetushu.json');
const chunksFile = path.join(rawDir, 'chunks.jsonl');
if (!fs.existsSync(chunksFile)) {
  console.error(`无 ${chunksFile}——先跑 hetushu-drive.mjs`);
  process.exit(2);
}
const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
// 站点清洗规则表（Legado 替换净化同款语义）：逐条 enabled 勾选，命中数进 QA 报告
const RULES = (profile.cleanRules ?? [])
  .filter((r) => r && r.enabled !== false && typeof r.pattern === 'string')
  .map((r) => ({ name: r.name ?? r.pattern.slice(0, 30), replacement: r.replacement ?? '', re: new RegExp(r.pattern, 'gi') }));
const UI_LINES = new Set(profile.uiLines);
const fullWidth = profile.fullWidthNormalize !== false;

function sanitize(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '·')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 全角 ASCII → 半角（部分站点用全角变体水印 dodge 过滤器，先归一再清洗）。 */
function fw2hw(s) {
  return fullWidth ? s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) : s;
}

/** 正文清洗：规则表逐条替换（token 级，行内插字也命中）+ UI 行剔除 + 空段收敛。返回 {text, hits}。 */
function cleanText(text) {
  let s = fw2hw(text);
  const hits = {};
  for (const r of RULES) {
    const n = (s.match(r.re) ?? []).length;
    if (n) {
      hits[r.name] = (hits[r.name] ?? 0) + n;
      s = s.replace(r.re, r.replacement);
    }
  }
  const out = s
    .split(/\n+/)
    .map((t) => t.trim())
    .filter((t) => t && !UI_LINES.has(t))
    .join('\n\n');
  return { text: out, hits };
}

const rows = fs
  .readFileSync(chunksFile, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .sort((a, b) => a.order - b.order);

// 不变量①：URL 去重（目录翻页边界同页双抓——0830 实测 1393 条 → 1137 唯一页，256 组相邻重复）。
// 保留首现，order 按去重后位置重排；此防线放在物化层强制执行，上游脚本有无去重都兜得住。
const seenUrls = new Set();
const deduped = [];
let urlDup = 0;
for (const r of rows) {
  if (r.url && seenUrls.has(r.url)) {
    urlDup++;
    continue;
  }
  if (r.url) seenUrls.add(r.url);
  deduped.push(r);
}
deduped.forEach((r, i) => {
  r.order = i + 1;
});

const volDir = path.join(workDir, 'manuscript', '正文');
fs.mkdirSync(volDir, { recursive: true });

const qa = { profile: profile.name, rawRows: rows.length, urlDup, uniqueChapters: deduped.length, written: 0, empty: 0, hashDup: [], watermarkResidual: [], latinFragments: {}, ruleHits: {}, suspects: [], totalChars: 0 };
const seenHash = new Map();
const lens = [];
for (const r of deduped) {
  const { text, hits } = cleanText(r.text ?? '');
  for (const [name, n] of Object.entries(hits)) qa.ruleHits[name] = (qa.ruleHits[name] ?? 0) + n;
  if (!text.trim()) {
    qa.empty++;
    continue;
  }
  // 不变量②：内容哈希去重（不同 URL 同内容——源站自身重复或伪影）
  const hash = createHash('sha1').update(text.replace(/\s/g, '')).digest('hex').slice(0, 16);
  if (seenHash.has(hash)) {
    qa.hashDup.push({ kept: seenHash.get(hash), dropped: r.order, title: r.title });
    continue;
  }
  seenHash.set(hash, r.order);
  // QA 门：清洗后规则残留必须为 0，否则在报告中点名（防站点轮换水印静默污染）
  const residualHits = RULES.reduce((n, rule) => n + (text.match(rule.re) ?? []).length, 0);
  if (residualHits) qa.watermarkResidual.push({ order: r.order, title: r.title, hits: residualHits });
  // 金丝雀（信息面，不设门）：CJK 夹拉丁残段普查——未知新水印家族的第一信号，计数异常升高即人查
  for (const m of text.matchAll(/[\u4e00-\u9fff](?:[a-zA-Z]{2,6}(?:[•·.][a-zA-Z]{1,6}){0,3}|[a-zA-Z]{1,6}(?:[•·.][a-zA-Z]{1,6}){1,3})[\u4e00-\u9fff]/g)) {
    const fam = m[0].slice(1, -1);
    qa.latinFragments[fam] = (qa.latinFragments[fam] ?? 0) + 1;
  }
  const fm = [
    '---',
    `title: ${r.title}`,
    'status: 语料',
    `source: ${profile.name}《诡秘之主》爱潜水的乌贼 · https://${profile.name}.com${r.url}`,
    'volume: 正文',
    `order: ${r.order}`,
    `wordNumber: ${text.replace(/\s/g, '').length}`,
    '---',
    '',
  ];
  // 文件名带序号前缀：各部章节名重复（第一章…第N章 ×多卷）防覆盖
  const fname = `${String(r.order).padStart(4, '0')}-${sanitize(r.title)}.md`;
  fs.writeFileSync(path.join(volDir, fname), fm.join('\n') + text.trim() + '\n', 'utf8');
  qa.written++;
  qa.totalChars += text.length;
  lens.push({ order: r.order, title: r.title, chars: text.replace(/\s/g, '').length });
}
// 不变量③：保真度分布（蒸馏台同款口径：低于中位 50% 标疑点，语义门由上游把关）
const sorted = [...lens.map((x) => x.chars)].sort((a, b) => a - b);
const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
qa.fidelity = { median, suspectThreshold: Math.max(Math.floor(median * 0.5), 200) };
qa.suspects = lens.filter((x) => x.chars < qa.fidelity.suspectThreshold).slice(0, 20);

fs.writeFileSync(path.join(workDir, 'report-materialize.json'), JSON.stringify(qa, null, 1), 'utf8');
console.log(`物化完成：${qa.written} 章 → ${volDir}`);
console.log(`QA：URL 去重 ${urlDup}｜内容哈希重复 ${qa.hashDup.length}｜空章 ${qa.empty}｜规则残留 ${qa.watermarkResidual.length} 章（必须 0）｜保真度中位 ${median} 字、疑点 ${qa.suspects.length} 章`);
console.log(`规则命中：${Object.entries(qa.ruleHits).map(([k, v]) => `${k}×${v}`).join('｜') || '无'}`);
if (Object.keys(qa.latinFragments).length) console.error(`[金丝雀] CJK夹拉丁残段（人查是否新水印）：${Object.entries(qa.latinFragments).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join(' ')}`);
if (qa.watermarkResidual.length) console.error(`[QA] 水印残留样例：${JSON.stringify(qa.watermarkResidual.slice(0, 3))}`);
if (qa.suspects.length) console.error(`[QA] 疑点章（<中位50%）：${qa.suspects.slice(0, 5).map((s) => `${s.order} ${s.title} ${s.chars}字`).join('；')}`);
