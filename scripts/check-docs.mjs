#!/usr/bin/env node
// scripts/check-docs.mjs —— 文档规则脚本兜底(规则见 AGENTS.md「加载规则」与 docs/current/现状.md 规范节)
// 违规即红:1) current/ 禁手写版本头  2) reference/ 必须 YAML front matter  3) AGENTS.md ≤ 50 行  4) archive 索引在位
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let fail = 0;
const err = (msg) => { console.error(`ERROR: ${msg}`); fail = 1; };

// 1. docs/current/ 禁止手写版本头(文件历史归 git,条目级日期不算)
const versionHeader = /^#*\s*(版本|Version|最后更新|Last update)\s*[:：]/m;
for (const f of readdirSync('docs/current')) {
  if (!f.endsWith('.md')) continue;
  if (versionHeader.test(readFileSync(join('docs/current', f), 'utf8'))) {
    err(`docs/current/${f} 发现手写版本头(应交给 git)`);
  }
}

// 2. docs/reference/ 每个 md 必须有 YAML front matter
for (const f of readdirSync('docs/reference')) {
  if (!f.endsWith('.md')) continue;
  const firstLine = readFileSync(join('docs/reference', f), 'utf8').split('\n', 1)[0].trim();
  if (firstLine !== '---') err(`docs/reference/${f} 缺少 YAML front matter`);
}

// 3. AGENTS.md 行数上限 50(防错清单,不是说明书)
const agentsLines = readFileSync('AGENTS.md', 'utf8').split('\n').length;
if (agentsLines > 50) err(`AGENTS.md 当前 ${agentsLines} 行,超 50 行上限`);

// 4. archive/ 逐件索引在位(防旧文档被误读为现行方案)
if (!existsSync('docs/archive/README.md')) err('docs/archive/README.md 索引缺失');

if (!fail) console.log('check-docs OK');
process.exit(fail);
