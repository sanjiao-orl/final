// release.mjs —— 真实发布脚本（零依赖 node）。
// 职责：同步三处版本号 → 带签名私钥跑 tauri build → 收集 bundle/.sig → 生成 latest.json → gh release 上传。
// 用法：
//   npm run release -- 0.1.1            # 指定版本
//   npm run release -- patch            # patch/minor/major 自增
//   npm run release -- 0.1.1 --notes "..." --skip-build
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

function uploadRelease(repo, version, notes, files) {
  const tag = `v${version}`;
  const fileArgs = files.map((f) => path.resolve(f));
  if (releaseExists(repo, version)) {
    console.log(`[release] release ${tag} 已存在，改为 upload --clobber`);
    const status = run('gh', ['release', 'upload', tag, ...fileArgs, '--repo', repo, '--clobber']);
    if (status !== 0) fail(`gh release upload 失败，退出码 ${status}`);
  } else {
    const status = run('gh', [
      'release', 'create', tag,
      ...fileArgs,
      '--repo', repo,
      '--title', tag,
      '--notes', notes || `发布 v${version}`,
    ]);
    if (status !== 0) fail(`gh release create 失败，退出码 ${status}`);
  }
}

function main() {
  const { target, notes, skipBuild, repo: repoArg } = parseArgv(process.argv.slice(2));
  const before = currentVersion();
  const version = bumpVersion(before, target);
  const repo = repoArg || detectRepo();

  console.log(`[release] ${before} → v${version}（repo: ${repo}）`);
  syncVersions(version);

  if (!skipBuild) {
    cleanBundles();
    build();
  }

  const { nsis, sig, msi, files } = collectArtifacts(version);
  const latestPath = writeLatestJson({ version, notes, nsis, sig, repo });
  files.push(latestPath);

  ensureGh(repo);
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
