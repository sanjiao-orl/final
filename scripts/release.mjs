// release.mjs —— 真实发布脚本（零依赖 node）。
// 职责：工作树预检 → 同步五处版本号（tauri.conf.json、shell/package.json、Cargo.toml、core/package.json、domain/package.json，写完后自检）
//       → 带签名私钥跑 tauri build → 收集 bundle/.sig → 生成 latest.json → 版本落账（自动 commit/tag/push）→ 发布 release。
// 发布流程（对网络限速/断流友好，幂等续传）：
//   1) 工作树预检：git status --porcelain 非空则列出脏文件并中止，防止带未提交改动发版；
//   2) gh release create vX.Y.Z --draft（只带 notes 不带文件；已存在则复用，可幂等续传）；
//   3) 逐个文件用 gh release upload --clobber 上传（gh 走 rustls，根治 Windows curl/schannel 传大文件
//      握手即卡死的问题——2026-08-17 v0.2.2 发布实证：curl 代理/直连三步全卡 0 字节，gh 同刻传 26MB/40MB 秒级成功；
//      断传残留由 --clobber 覆盖；失败默认 3 次、间隔 15s 重试）；
//   4) 全部资产传完才 gh release edit vX.Y.Z --draft=false 发布；任一文件重试耗尽则中止并保留草稿，
//      打印续传指引——修复网络后重跑同一命令即可（幂等）。
// 版本落账自动化：build 后自动 git add 六件（tauri.conf.json、shell/package.json、Cargo.toml、core/package.json、domain/package.json、Cargo.lock）
//      并 commit -m "chore(release): bump vX.Y.Z"、git tag vX.Y.Z、git push origin HEAD 与 vX.Y.Z；
//      先推 tag 再传资产，gh release create 复用远端已存在的 tag（指向含版本号的提交）。每步幂等：
//      无 staged 差异跳过 commit、本地 tag 已存在跳过打标、push 已同步照常通过，重跑续传不炸。
// 用法：
//   npm run release -- 0.1.1            # 指定版本
//   npm run release -- patch            # patch/minor/major 自增
//   npm run release -- 0.1.1 --notes "..." --skip-build
// 注意：发版要求工作树干净（有未提交改动会直接拦截）；版本号改动由脚本自动落账，无需手动 commit/tag/push。
// 签名私钥：默认 <用户目录>/.tauri/novel-ws.key；可用 TAURI_SIGNING_PRIVATE_KEY_PATH 覆盖路径，
// 或 TAURI_SIGNING_PRIVATE_KEY 直接给密钥内容；密码用 TAURI_SIGNING_PRIVATE_KEY_PASSWORD（本仓密钥为空密码）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellDir = path.join(root, 'shell');
const tauriConfPath = path.join(shellDir, 'src-tauri', 'tauri.conf.json');
const shellPkgPath = path.join(shellDir, 'package.json');
const cargoTomlPath = path.join(shellDir, 'src-tauri', 'Cargo.toml');
const bundleDir = path.join(shellDir, 'src-tauri', 'target', 'release', 'bundle');

function fail(msg) {
  console.error(`[release] ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  return res.status ?? 1;
}

function runCapture(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeJson(p, value) {
  writeFileSync(p, `${JSON.stringify(value, null, 2)}\n`);
}

function currentVersion() {
  return readJson(shellPkgPath).version;
}

function parseArgv(argv) {
  let target = 'patch';
  let notes = null;
  let skipBuild = false;
  let repo = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--notes') {
      notes = argv[i + 1];
      if (!notes) fail('--notes 需要一个参数');
      i += 1;
    } else if (a.startsWith('--notes=')) {
      notes = a.slice('--notes='.length);
    } else if (a === '--repo') {
      repo = argv[i + 1];
      if (!repo) fail('--repo 需要一个参数');
      i += 1;
    } else if (a.startsWith('--repo=')) {
      repo = a.slice('--repo='.length);
    } else if (a === '--skip-build') {
      skipBuild = true;
    } else if (a === '--help' || a === '-h') {
      console.log(`用法: node scripts/release.mjs [patch|minor|major|X.Y.Z] [--notes <文本>] [--repo <owner/repo>] [--skip-build]`);
      process.exit(0);
    } else if (a.startsWith('-')) {
      fail(`未知参数: ${a}`);
    } else {
      target = a;
    }
  }
  return { target, notes, skipBuild, repo };
}

function bumpVersion(current, target) {
  const semverRe = /^(\d+)\.(\d+)\.(\d+)$/;
  if (semverRe.test(target)) return target;
  const m = current.match(semverRe);
  if (!m) fail(`当前版本非法: ${current}`);
  let [, major, minor, patch] = m.map(Number);
  if (target === 'patch') patch += 1;
  else if (target === 'minor') {
    minor += 1;
    patch = 0;
  } else if (target === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else {
    fail(`版本参数必须为 patch/minor/major 或 X.Y.Z，收到: ${target}`);
  }
  return `${major}.${minor}.${patch}`;
}

function setCargoPackageVersion(text, version) {
  const re = /(^version\s*=\s*")[^"]*(")/m;
  if (!re.test(text)) fail('Cargo.toml 中未找到 [package] version 行');
  return text.replace(re, `$1${version}$2`);
}

function syncVersions(version) {
  const tauriConf = readJson(tauriConfPath);
  tauriConf.version = version;
  writeJson(tauriConfPath, tauriConf);

  const shellPkg = readJson(shellPkgPath);
  shellPkg.version = version;
  writeJson(shellPkgPath, shellPkg);

  const cargoToml = readFileSync(cargoTomlPath, 'utf8');
  writeFileSync(cargoTomlPath, setCargoPackageVersion(cargoToml, version));

  // core/domain 也同步（sidecar 自报版本取自它们的 package.json，漏掉会不一致）
  for (const sub of ['core', 'domain']) {
    const pkgPath = path.join(root, sub, 'package.json');
    const pkg = readJson(pkgPath);
    pkg.version = version;
    writeJson(pkgPath, pkg);
  }
}

function defaultKeyPath() {
  return path.join(os.homedir(), '.tauri', 'novel-ws.key');
}

function buildEnv() {
  const env = { ...process.env };
  // tauri build 的签名只认 TAURI_SIGNING_PRIVATE_KEY（密钥内容），不认 _PATH。
  if (!env.TAURI_SIGNING_PRIVATE_KEY) {
    const keyPath = env.TAURI_SIGNING_PRIVATE_KEY_PATH || defaultKeyPath();
    if (!existsSync(keyPath)) {
      fail(`签名私钥不存在: ${keyPath}。请用 TAURI_SIGNING_PRIVATE_KEY 提供密钥内容，或 TAURI_SIGNING_PRIVATE_KEY_PATH 覆盖路径。`);
    }
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, 'utf8').trim();
  }
  delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
  }
  return env;
}

function detectRepo() {
  const res = runCapture('git', ['remote', 'get-url', 'origin'], { cwd: root });
  if (res.status === 0) {
    const url = res.stdout.trim();
    const m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return 'sanjiao-orl/final';
}

// 工作树预检：带未提交改动发版会把未完成代码带进版本提交/tag，先拦截。
function assertCleanWorktree() {
  const res = runCapture('git', ['status', '--porcelain'], { cwd: root });
  if (res.status !== 0) fail('git status 执行失败，请确认处于 git 仓库内');
  const dirty = res.stdout.trim();
  if (dirty) {
    for (const line of dirty.split(/\r?\n/)) console.error(`[release] 未提交改动: ${line}`);
    fail('工作树有未提交改动，请先提交');
  }
}

// 版本落账自动化：把版本号改动连同 Cargo.lock 提交、打 tag、推送到 origin。
// 先推 tag 再走 uploadRelease，gh release create 复用远端已存在的 tag（指向含版本号的提交，而非默认分支旧 HEAD）。
// 每步幂等：无 staged 差异跳过 commit、本地 tag 已存在跳过打标、push 已同步照常通过，重跑续传不炸。
function commitAndPush(version) {
  const tag = `v${version}`;
  const files = [
    'shell/src-tauri/tauri.conf.json',
    'shell/package.json',
    'shell/src-tauri/Cargo.toml',
    'core/package.json',
    'domain/package.json',
    'shell/src-tauri/Cargo.lock',
  ];
  if (run('git', ['add', ...files], { cwd: root }) !== 0) fail('git add 失败');

  // 有 staged 差异才提交；重跑续传时差异已被上一次提交带走，跳过。
  if (runCapture('git', ['diff', '--cached', '--quiet'], { cwd: root }).status !== 0) {
    if (run('git', ['commit', '-m', `chore(release): bump ${tag}`], { cwd: root }) !== 0) fail('git commit 失败');
    console.log(`[release] 已提交版本号: chore(release): bump ${tag}`);
  } else {
    console.log('[release] 无 staged 差异，跳过 commit（幂等续传）');
  }

  // 本地已存在同名 tag 才跳过，避免重复打标。
  if (runCapture('git', ['tag', '-l', tag], { cwd: root }).stdout.trim() === tag) {
    console.log(`[release] tag ${tag} 已存在，跳过打标（幂等续传）`);
  } else if (run('git', ['tag', tag], { cwd: root }) !== 0) {
    fail('git tag 失败');
  } else {
    console.log(`[release] 已打本地 tag ${tag}`);
  }

  // 推送分支与 tag；失败时打印手动补救命令，修好后重跑同一命令续传。
  if (run('git', ['push', 'origin', 'HEAD'], { cwd: root }) !== 0) {
    fail(`git push origin HEAD 失败，请手动补救后重跑:\n  git push origin HEAD\n  git push origin ${tag}`);
  }
  if (run('git', ['push', 'origin', tag], { cwd: root }) !== 0) {
    fail(`git push origin ${tag} 失败，请手动补救后重跑:\n  git push origin ${tag}`);
  }
  console.log(`[release] 已推送分支与 tag ${tag} 到 origin`);
}

function ensureGh(repo) {
  if (runCapture('gh', ['--version']).status !== 0) {
    fail('未找到 gh CLI。请先安装 GitHub CLI：https://cli.github.com/');
  }
  if (runCapture('gh', ['auth', 'status', '--hostname', 'github.com']).status !== 0) {
    fail('gh 未登录 github.com。请先执行: gh auth login');
  }
}

function cleanBundles() {
  for (const dir of ['nsis', 'msi']) {
    const p = path.join(bundleDir, dir);
    rmSync(p, { recursive: true, force: true });
    // Tauri bundler 复制产物时不会创建已删除的 bundle 子目录，这里立即补回。
    mkdirSync(p, { recursive: true });
  }
}

function build() {
  // Windows 下 Node 不能直接 spawn npx.cmd（EINVAL/ENOENT），经 cmd.exe 转发。
  const cmd = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npx';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npx tauri build --ci'] : ['tauri', 'build', '--ci'];
  console.log(`[release] 开始 tauri build（cwd: ${shellDir}）`);
  const status = run(cmd, args, { cwd: shellDir, env: buildEnv() });
  if (status !== 0) fail(`tauri build 失败，退出码 ${status}`);
}

function collectArtifacts(version) {
  const nsis = path.join(bundleDir, 'nsis', `novel-ws_${version}_x64-setup.exe`);
  const sig = `${nsis}.sig`;
  const msi = path.join(bundleDir, 'msi', `novel-ws_${version}_x64_en-US.msi`);
  if (!existsSync(nsis)) fail(`找不到 NSIS 安装包: ${nsis}`);
  if (!existsSync(sig)) {
    fail(`找不到签名文件: ${sig}。请确认已设置 TAURI_SIGNING_PRIVATE_KEY_PATH / TAURI_SIGNING_PRIVATE_KEY（本仓密钥路径: ${defaultKeyPath()}）`);
  }
  const files = [nsis, sig];
  if (existsSync(msi)) {
    files.push(msi);
  } else {
    console.warn('[release] 未找到 MSI 安装包，仅上传 NSIS + 签名 + latest.json');
  }
  return { nsis, sig, msi, files };
}

function writeLatestJson({ version, notes, nsis, sig, repo }) {
  const latest = {
    version,
    notes: notes || `发布 v${version}`,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        url: `https://github.com/${repo}/releases/download/v${version}/${path.basename(nsis)}`,
        signature: readFileSync(sig, 'utf8').trim(),
      },
    },
  };
  const latestPath = path.join(bundleDir, 'latest.json');
  writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
  return latestPath;
}

function releaseExists(repo, version) {
  return runCapture('gh', ['release', 'view', `v${version}`, '--repo', repo], { stdio: 'ignore' }).status === 0;
}

const UPLOAD_MAX_ATTEMPTS = 3;   // 每个文件最大尝试次数
const UPLOAD_RETRY_SECONDS = 15; // 失败后重试间隔

function sleep(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

// 经 gh release upload 上传单个文件（--clobber 覆盖同名的断传残留；gh 走 rustls，
// 根治 Windows curl/schannel 传大文件握手即卡死的问题——2026-08-17 v0.2.2 发布实证）。
function uploadFile(repo, tag, file) {
  const name = path.basename(file);
  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    console.log(`[release] 上传 ${name}（第 ${attempt}/${UPLOAD_MAX_ATTEMPTS} 次，gh release upload）`);
    if (run('gh', ['release', 'upload', tag, '--repo', repo, '--clobber', file]) === 0) {
      console.log(`[release] 上传成功 ${name}`);
      return true;
    }
    console.warn(`[release] 上传失败 ${name}，${UPLOAD_RETRY_SECONDS}s 后重试…`);
    if (attempt < UPLOAD_MAX_ATTEMPTS) sleep(UPLOAD_RETRY_SECONDS);
  }
  return false;
}

function uploadRelease(repo, version, notes, files) {
  const tag = `v${version}`;

  // 阶段一：确保草稿 release 存在（只带 notes，不带文件；已存在则复用，幂等续传）
  if (releaseExists(repo, version)) {
    console.log(`[release] release ${tag} 已存在，复用（保持草稿，继续传资产）`);
  } else {
    const status = run('gh', ['release', 'create', tag, '--repo', repo, '--title', tag, '--notes', notes || `发布 v${version}`, '--draft']);
    if (status !== 0) fail(`gh release create --draft 失败，退出码 ${status}`);
    console.log(`[release] 已创建草稿 release ${tag}`);
  }

  // 阶段二：逐个文件 gh release upload；任一文件重试耗尽即中止，保留草稿供续传
  for (const file of files) {
    if (!uploadFile(repo, tag, file)) {
      console.error(`[release] 资产上传失败: ${path.basename(file)}`);
      console.error(`[release] 草稿已保留: https://github.com/${repo}/releases/tag/${tag}`);
      console.error(`[release] 请修复网络后重跑同一命令（幂等：已传文件由 --clobber 覆盖重传，未传的续传）。`);
      process.exit(1);
    }
  }

  // 阶段三：全部传完才发布
  const edit = run('gh', ['release', 'edit', tag, '--repo', repo, '--draft=false']);
  if (edit !== 0) fail(`gh release edit --draft=false 失败，退出码 ${edit}`);
  console.log(`[release] release ${tag} 已发布（draft=false）。`);
}

function main() {
  const { target, notes, skipBuild, repo: repoArg } = parseArgv(process.argv.slice(2));
  assertCleanWorktree();
  const before = currentVersion();
  const version = bumpVersion(before, target);
  const repo = repoArg || detectRepo();

  console.log(`[release] ${before} → v${version}（repo: ${repo}）`);
  syncVersions(version);

  // 版本单一事实源自检：五处写入后必须一致，否则中止，防止带着漂移版本发布。
  const checkStatus = run('node', [path.join(root, 'scripts', 'check-versions.mjs')]);
  if (checkStatus !== 0) fail(`版本自检失败：check-versions.mjs 退出码 ${checkStatus}`);

  if (!skipBuild) {
    cleanBundles();
    build();
  }

  const { nsis, sig, msi, files } = collectArtifacts(version);
  const latestPath = writeLatestJson({ version, notes, nsis, sig, repo });
  files.push(latestPath);

  ensureGh(repo);
  commitAndPush(version);
  uploadRelease(repo, version, notes, files);

  console.log('[release] 完成。');
  console.log(`  Release: https://github.com/${repo}/releases/tag/v${version}`);
  console.log(`  latest.json: https://github.com/${repo}/releases/latest/download/latest.json`);
  console.log(`  NSIS: https://github.com/${repo}/releases/download/v${version}/${path.basename(nsis)}`);
  if (existsSync(msi)) {
    console.log(`  MSI: https://github.com/${repo}/releases/download/v${version}/${path.basename(msi)}`);
  }
}

main();
