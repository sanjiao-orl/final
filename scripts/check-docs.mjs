#!/usr/bin/env node
// scripts/check-docs.mjs —— 文档规则脚本兜底
// 检查清单:
// 1) docs/current/ 禁手写版本头 (error)
// 2) docs/reference/ 必须 YAML front matter 且含 last-verified 与 verified_commit (error)
// 3) AGENTS.md ≤ 50 行 (error)
// 4) docs/archive/README.md 索引在位 (error)
// 5) 活跃层 (current/reference/drafts/work) 禁引 archive (error)
// 6) docs/work/ sealed 滞留检查 (error)
// 7) 体量预算: current ≤ 12288B, reference ≤ 8192B (warn)
// 8) 决策文体检查: current 与 reference 禁出现决策特征词 (warn)
// 9) 协议一致性: 三处事实源版本对齐 (error) & core 路由全量见于 reference/03 文档 (error)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let fail = 0;
const err = (msg) => { console.error(`ERROR: ${msg}`); fail = 1; };
const warn = (msg) => { console.warn(`WARN: ${msg}`); };

function getMdFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md'));
}

// 1. docs/current/ 禁止手写版本头(文件历史归 git,条目级日期不算)
const versionHeader = /^#*\s*(版本|Version|最后更新|Last update)\s*[:：]/m;
for (const f of getMdFiles('docs/current')) {
  const content = readFileSync(join('docs/current', f), 'utf8');
  if (versionHeader.test(content)) {
    err(`docs/current/${f} 发现手写版本头(应交给 git)`);
  }
}

// 2 & 2a. docs/reference/ 每个 md 必须有 YAML front matter，且含 last-verified 与 verified_commit 字段
for (const f of getMdFiles('docs/reference')) {
  const content = readFileSync(join('docs/reference', f), 'utf8');
  const firstLine = content.split('\n', 1)[0].trim();
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (firstLine !== '---' || !fmMatch) {
    err(`docs/reference/${f} 缺少 YAML front matter`);
  } else {
    const fm = fmMatch[1];
    if (!/last-verified\s*:/m.test(fm)) {
      err(`docs/reference/${f} front matter 缺少 last-verified 字段`);
    }
    if (!/verified_commit\s*:/m.test(fm)) {
      err(`docs/reference/${f} front matter 缺少 verified_commit 字段`);
    }
  }
}

// 3. AGENTS.md 行数上限 50(防错清单,不是说明书)
if (existsSync('AGENTS.md')) {
  const agentsLines = readFileSync('AGENTS.md', 'utf8').split('\n').length;
  if (agentsLines > 50) err(`AGENTS.md 当前 ${agentsLines} 行,超 50 行上限`);
}

// 4. archive/ 逐件索引在位(防旧文档被误读为现行方案)
if (!existsSync('docs/archive/README.md')) err('docs/archive/README.md 索引缺失');

// 5. 活跃层禁引 archive (扫描 docs/current, docs/reference, docs/drafts, docs/work)
const activeDirs = ['docs/current', 'docs/reference', 'docs/drafts', 'docs/work'];
for (const dir of activeDirs) {
  for (const f of getMdFiles(dir)) {
    const relPath = join(dir, f).replace(/\\/g, '/');
    const content = readFileSync(join(dir, f), 'utf8');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (line.includes('docs/archive/') || line.includes('(archive/')) {
        err(`${relPath}:${idx + 1} 活跃层禁止引用 archive 路径`);
      }
    });
  }
}

// 6. docs/work/ sealed 滞留检查
for (const f of getMdFiles('docs/work')) {
  const content = readFileSync(join('docs/work', f), 'utf8');
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const targetFm = fmMatch ? fmMatch[1] : content;
  if (/status\s*:\s*sealed/m.test(targetFm)) {
    err(`docs/work/${f} 含 status: sealed，已封存件须移入 archive`);
  }
}

// 7. 体量预算 (warn)
for (const f of getMdFiles('docs/current')) {
  const buf = Buffer.from(readFileSync(join('docs/current', f), 'utf8'), 'utf8');
  if (buf.length > 12288) {
    warn(`docs/current/${f} 体量超限: ${buf.length} 字节 > 12288 字节`);
  }
}
for (const f of getMdFiles('docs/reference')) {
  const buf = Buffer.from(readFileSync(join('docs/reference', f), 'utf8'), 'utf8');
  if (buf.length > 8192) {
    warn(`docs/reference/${f} 体量超限: ${buf.length} 字节 > 8192 字节`);
  }
}

// 8. 决策文体检查 (warn)
const decisionWords = ['落选', '被否选项', '已定稿'];
for (const dir of ['docs/current', 'docs/reference']) {
  for (const f of getMdFiles(dir)) {
    const relPath = join(dir, f).replace(/\\/g, '/');
    const content = readFileSync(join(dir, f), 'utf8');
    for (const word of decisionWords) {
      if (content.includes(word)) {
        warn(`${relPath} 出现决策特征词「${word}」`);
      }
    }
  }
}

// 9. 协议一致性 (error)
// 9a. 三处事实源相等
let runtimeProto = null;
let tauriProto = null;
let svelteProto = null;

if (existsSync('core/src/runtime.ts')) {
  const content = readFileSync('core/src/runtime.ts', 'utf8');
  const m = content.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
  if (m) runtimeProto = m[1];
}
if (existsSync('shell/src-tauri/src/lib.rs')) {
  const content = readFileSync('shell/src-tauri/src/lib.rs', 'utf8');
  const m = content.match(/EXPECTED_PROTOCOL\s*:\s*u64\s*=\s*(\d+)/);
  if (m) tauriProto = m[1];
}
if (existsSync('shell/src/App.svelte')) {
  const content = readFileSync('shell/src/App.svelte', 'utf8');
  const m = content.match(/EXPECTED_PROTOCOL\s*=\s*(\d+)/);
  if (m) svelteProto = m[1];
}

if (!runtimeProto || !tauriProto || !svelteProto || runtimeProto !== tauriProto || tauriProto !== svelteProto) {
  err(`协议版本三处事实源不一致: core/src/runtime.ts (${runtimeProto ?? '未匹配'}), shell/src-tauri/src/lib.rs (${tauriProto ?? '未匹配'}), shell/src/App.svelte (${svelteProto ?? '未匹配'})`);
}

// 9b. 路由在文档
if (!existsSync('docs/reference/03-协议契约.md')) {
  err('docs/reference/03-协议契约.md 缺失');
} else if (existsSync('core/src/server.ts')) {
  const serverContent = readFileSync('core/src/server.ts', 'utf8');
  const docContent = readFileSync('docs/reference/03-协议契约.md', 'utf8');

  const routes = new Set();
  const eqRegex = /pathname\s*===\s*['"](\/v1\/[^'"]*)['"]/g;
  const startsRegex = /pathname\.startsWith\(['"](\/v1\/[^'"]*)['"]\)/g;

  for (const m of serverContent.matchAll(eqRegex)) {
    routes.add(m[1]);
  }
  for (const m of serverContent.matchAll(startsRegex)) {
    routes.add(m[1]);
  }

  const missingRoutes = [];
  for (const route of routes) {
    if (!docContent.includes(route)) {
      missingRoutes.push(route);
    }
  }
  if (missingRoutes.length > 0) {
    err(`docs/reference/03-协议契约.md 缺少以下路由契约说明: ${missingRoutes.join(', ')}`);
  }
}

if (!fail) console.log('check-docs OK');
process.exit(fail);
