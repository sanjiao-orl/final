// check-versions.mjs —— 版本号单一事实源自检（零依赖 node）。
// 断言 tauri.conf.json、Cargo.toml、core/domain/shell 三个 package.json 的 version 一致；
// 不一致时非零退出并列出各处取值。挂在根 package.json 的 check 尾部，也供 release.mjs 写完后自检。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** 取 Cargo.toml [package] 段的 version（首个行首 version = "..."，即包自身版本）。 */
function readCargoVersion(p) {
  const text = readFileSync(p, 'utf8');
  const m = /^version\s*=\s*"([^"]+)"/m.exec(text);
  if (!m) fail(`Cargo.toml 未找到 [package] version 行: ${p}`);
  return m[1];
}

function fail(msg) {
  console.error(`[check-versions] ${msg}`);
  process.exit(1);
}

const entries = [
  ['shell/src-tauri/tauri.conf.json', readJson(path.join(root, 'shell', 'src-tauri', 'tauri.conf.json')).version],
  ['shell/src-tauri/Cargo.toml', readCargoVersion(path.join(root, 'shell', 'src-tauri', 'Cargo.toml'))],
  ['core/package.json', readJson(path.join(root, 'core', 'package.json')).version],
  ['domain/package.json', readJson(path.join(root, 'domain', 'package.json')).version],
  ['shell/package.json', readJson(path.join(root, 'shell', 'package.json')).version],
];

const unique = new Set(entries.map(([, v]) => v));
if (unique.size !== 1) {
  console.error('[check-versions] 版本号不一致：');
  for (const [label, version] of entries) console.error(`  ${label}: ${version}`);
  process.exit(1);
}

console.log(`[check-versions] 一致：v${entries[0][1]}（${entries.map(([l]) => l).join('、')}）`);
