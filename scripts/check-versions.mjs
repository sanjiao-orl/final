// check-versions.mjs —— 版本号单一事实源自检（零依赖 node）。
// 断言 tauri.conf.json、Cargo.toml、core/domain/shell 三个 package.json、以及 package-lock.json 里的
// core/domain/shell 三份 workspace 版本（第六处）全部一致；不一致时非零退出并列出各处取值。
// 挂在根 package.json 的 check 尾部，也供 release.mjs 写完后自检。
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

// 第六处：package-lock.json 的 workspaces 版本段（core/domain/shell 三份，须与各自的 package.json 一致，
// 否则 npm 依赖解析视图与源代码不一致——实测曾全部漂移到旧版）。只读 JSON 校验，不做正则。
const lockfile = readJson(path.join(root, 'package-lock.json'));
const lockPkgs = lockfile.packages;
if (!lockPkgs || !lockPkgs.core || !lockPkgs.domain || !lockPkgs.shell) {
  fail('package-lock.json 缺少 packages.core/domain/shell 段，单源契约无法校验');
}

// 每个版本文件登记其 label 与版本取值（lockfile 一份文件含三份 workspace 子版本，仍算一处）。
const files = [
  { label: 'shell/src-tauri/tauri.conf.json', versions: [readJson(path.join(root, 'shell', 'src-tauri', 'tauri.conf.json')).version] },
  { label: 'shell/src-tauri/Cargo.toml', versions: [readCargoVersion(path.join(root, 'shell', 'src-tauri', 'Cargo.toml'))] },
  { label: 'core/package.json', versions: [readJson(path.join(root, 'core', 'package.json')).version] },
  { label: 'domain/package.json', versions: [readJson(path.join(root, 'domain', 'package.json')).version] },
  { label: 'shell/package.json', versions: [readJson(path.join(root, 'shell', 'package.json')).version] },
  { label: 'package-lock.json', versions: [lockPkgs.core.version, lockPkgs.domain.version, lockPkgs.shell.version] },
];

const all = files.flatMap((f) => f.versions);
if (new Set(all).size !== 1) {
  console.error('[check-versions] 版本号不一致：');
  for (const f of files) for (const v of f.versions) console.error(`  ${f.label}: ${v}`);
  process.exit(1);
}

console.log(`[check-versions] 六处一致：v${all[0]}（${files.map((f) => f.label).join('、')}）`);
