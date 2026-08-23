// release.mjs —— 真实发布脚本（零依赖 node）。
// 职责：工作树预检 → 同步六处版本号（tauri.conf.json、shell/package.json、Cargo.toml、core/package.json、domain/package.json、
//       package-lock.json 的 core/domain/shell 三段，并顺带同步 Cargo.lock 的 name = "app" 版本，写完后自检）
//       → 带签名私钥跑 tauri build（仅 NSIS：core/prompts/ 中文目录名超出 WiX 1252 码页，MSI 已弃，
//       tauri.conf.json bundle.targets = ["nsis"]）→ 收集 bundle/.sig → 生成 latest.json → 版本落账（自动 commit/tag/push）→ 发布 release。
// 发布流程（对网络限速/断流友好，幂等续传）：
//   1) 工作树预检：git status --porcelain 非空则列出脏文件；除版本文件（见 VERSION_FILES）外的任何脏文件
//      中止，防止带未完成代码发版；仅版本文件脏时放行（那是上次发版半途遗留，续跑会覆盖重算为一致值）；
//   2) gh release create vX.Y.Z --draft（只带 notes 不带文件；已存在则复用，可幂等续传）；
//   3) 逐个文件用 gh release upload --clobber 上传（gh 走 rustls，根治 Windows curl/schannel 传大文件
//      握手即卡死的问题——2026-08-17 v0.2.2 发布实证：curl 代理/直连三步全卡 0 字节，gh 同刻传 26MB/40MB 秒级成功；
//      断传残留由 --clobber 覆盖；失败默认 3 次、间隔 15s 重试）；
//   4) 全部资产传完才 gh release edit vX.Y.Z --draft=false 发布；任一文件重试耗尽则中止并保留草稿，
//      打印续传指引——修复网络后重跑同一命令即可（幂等）。
// 版本落账自动化：build 后自动 git add 七件（tauri.conf.json、shell/package.json、Cargo.toml、core/package.json、domain/package.json、Cargo.lock、package-lock.json）
//      并 commit -m "chore(release): bump vX.Y.Z"、git tag vX.Y.Z、git push origin HEAD 与 vX.Y.Z；
//      先推 tag 再传资产，gh release create 复用远端已存在的 tag（指向含版本号的提交）。每步幂等：
//      无 staged 差异跳过 commit、本地 tag 已存在跳过打标、push 已同步照常通过，重跑续传不炸。
// 用法：
//   npm run release -- 0.1.1            # 指定版本
//   npm run release -- patch            # patch/minor/major 自增
//   npm run release -- 0.1.1 --notes "..." --skip-build
//   npm run release -- patch --dry-run  # 无副作用演练：只读预检+版本内容内存校验+打印动作计划，不写盘不联网不动 git
// 护栏（0014 决策 2）：① 版本写入事务化——七处新内容全部在内存构造并逐项校验通过后才落盘，
//   校验阶段零写入，杜绝写到一半失败留下半套改动；落盘中断可重跑覆盖（幂等），落盘后仍有 check-versions 自检兜底；
// ② --dry-run 空跑演练，产物缺失降级为警告（正式运行会先 build 出来）；③ 自增防呆——自增算出的版本其本地 tag 已存在即拦截
//   （几乎总是半途续传误用自增把版本算错），续传必须显式指定版本号。
// 注意：发版要求工作树干净（除版本文件外有未提交改动会直接拦截）；版本号改动由脚本自动落账，无需手动 commit/tag/push。
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
const cargoLockPath = path.join(shellDir, 'src-tauri', 'Cargo.lock');
const rootLockPath = path.join(root, 'package-lock.json');
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

function currentVersion() {
  return readJson(shellPkgPath).version;
}

function parseArgv(argv) {
  let target = 'patch';
  let notes = null;
  let skipBuild = false;
  let dryRun = false;
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
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--help' || a === '-h') {
      console.log(`用法: node scripts/release.mjs [patch|minor|major|X.Y.Z] [--notes <文本>] [--repo <owner/repo>] [--skip-build] [--dry-run]`);
      process.exit(0);
    } else if (a.startsWith('-')) {
      fail(`未知参数: ${a}`);
    } else {
      target = a;
    }
  }
  return { target, notes, skipBuild, dryRun, repo };
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

// 同步 Cargo.lock 里 name = "app" 段的 version（L-1：--skip-build 不重算 Cargo.lock，但落账仍固定提交它）。
// name 与 version 之间恒相邻（Cargo.lock 输出顺序固定），正则定位该段、只改 version 一个字段，最小替换。
function setCargoLockAppVersion(text, version) {
  const re = /(name = "app"\nversion = ")[^"]*(")/;
  if (!re.test(text)) fail('Cargo.lock 中未找到 name = "app" 段的 version 行');
  return text.replace(re, `$1${version}$2`);
}

// —— 版本写入事务化（0014 决策 2）——
// 第一阶段：纯内存构造全部七项写入 { path, content, assert }，不碰磁盘；
// assert 是对该项新内容的版本字段校验函数（与写入用同一构造路径，校验即复读）。
function computeVersionWrites(version) {
  const jsonAssert = (c) => JSON.parse(c).version === version;
  const writes = [];

  const tauriConf = readJson(tauriConfPath);
  tauriConf.version = version;
  writes.push({ path: tauriConfPath, content: `${JSON.stringify(tauriConf, null, 2)}\n`, assert: jsonAssert });

  const shellPkg = readJson(shellPkgPath);
  shellPkg.version = version;
  writes.push({ path: shellPkgPath, content: `${JSON.stringify(shellPkg, null, 2)}\n`, assert: jsonAssert });

  // core/domain 也同步（sidecar 自报版本取自它们的 package.json，漏掉会不一致）
  for (const sub of ['core', 'domain']) {
    const pkgPath = path.join(root, sub, 'package.json');
    const pkg = readJson(pkgPath);
    pkg.version = version;
    writes.push({ path: pkgPath, content: `${JSON.stringify(pkg, null, 2)}\n`, assert: jsonAssert });
  }

  const cargoTomlText = readFileSync(cargoTomlPath, 'utf8');
  writes.push({
    path: cargoTomlPath,
    content: setCargoPackageVersion(cargoTomlText, version),
    assert: (c) => /^version\s*=\s*"([^"]+)"/m.exec(c)?.[1] === version,
  });

  // 第六处：package-lock.json 的 workspaces 版本段同步（core/domain/shell 三段），否则 npm 依赖解析视图与源码漂移。
  const lock = readJson(rootLockPath);
  for (const sub of ['core', 'domain', 'shell']) {
    if (!lock.packages?.[sub]) fail(`package-lock.json 缺少 packages.${sub} 段，无法同步版本`);
    lock.packages[sub].version = version;
  }
  writes.push({
    path: rootLockPath,
    content: `${JSON.stringify(lock, null, 2)}\n`,
    assert: (c) => ['core', 'domain', 'shell'].every((sub) => JSON.parse(c).packages[sub].version === version),
  });

  // L-1：--skip-build 时不重算 Cargo.lock，这里的同步保证提交的 Cargo.lock 也是当前版本。
  const cargoLockText = readFileSync(cargoLockPath, 'utf8');
  writes.push({
    path: cargoLockPath,
    content: setCargoLockAppVersion(cargoLockText, version),
    assert: (c) => /name = "app"\nversion = "([^"]*)"/.exec(c)?.[1] === version,
  });

  return writes;
}

// 第二阶段：逐项校验内存内容确实包含目标版本；任一不过即中止，此时一个字节都未写盘。
function verifyWrites(writes, version) {
  for (const w of writes) {
    if (!w.assert(w.content)) fail(`事务预校验失败（未写入任何文件）: ${path.relative(root, w.path)} 未包含目标版本 ${version}`);
  }
}

// 第三阶段：统一落盘。每项都是完整内容，中断后重跑覆盖重算（幂等），落盘后另有 check-versions 自检兜底。
function applyWrites(writes) {
  for (const w of writes) writeFileSync(w.path, w.content);
  console.log(`[release] 已事务化写入 ${writes.length} 处版本文件`);
}

function syncVersions(version) {
  const writes = computeVersionWrites(version);
  verifyWrites(writes, version);
  applyWrites(writes);
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

// 从 origin 远端 URL 解析目标仓（owner/repo）；解析失败打印醒目警告并回落硬编码默认仓，
// 提醒操作者 latest.json 下载地址与 gh release 目标都跟着它走，避免发错仓还不自知。
// 显式 --repo 时 main 不会调用本函数，故警告只在静默回落路径出现。
function detectRepo() {
  const fallback = 'sanjiao-orl/final';
  const res = runCapture('git', ['remote', 'get-url', 'origin'], { cwd: root });
  if (res.status !== 0) {
    console.error(`[release] [警告] git remote get-url origin 失败（退出码 ${res.status}${res.stderr.trim() ? `: ${res.stderr.trim()}` : ''}），将使用默认目标仓 ${fallback}——如非预期请用 --repo owner/repo 显式指定`);
    return fallback;
  }
  const url = res.stdout.trim();
  const m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) {
    console.error(`[release] [警告] 无法从 origin URL 解析 GitHub owner/repo（url: ${url || '<空>'}），将使用默认目标仓 ${fallback}——如非预期请用 --repo owner/repo 显式指定`);
    return fallback;
  }
  return `${m[1]}/${m[2]}`;
}

// 版本文件：发版半途中止（如 build 失败）会在工作树留下这些文件的版本号改动；重跑时 syncVersions 会
// 覆盖重算为一致值，故允许它们脏。白名单之外的任何脏文件视为"未完成代码"，照旧拦截。
const VERSION_FILES = new Set([
  'shell/src-tauri/tauri.conf.json',
  'shell/src-tauri/Cargo.toml',
  'shell/src-tauri/Cargo.lock',
  'core/package.json',
  'domain/package.json',
  'shell/package.json',
  'package-lock.json',
]);

// 工作树预检：带未提交改动发版会把未完成代码带进版本提交/tag，先拦截（版本文件除外，见上方注释）。
function assertCleanWorktree() {
  const res = runCapture('git', ['status', '--porcelain'], { cwd: root });
  if (res.status !== 0) fail('git status 执行失败，请确认处于 git 仓库内');
  const dirty = res.stdout.trim();
  if (dirty) {
    for (const line of dirty.split(/\r?\n/)) console.error(`[release] 工作树当前状态: ${line}`);
    // porcelain 前两字符是状态码，其后为路径（可能含空格；rename 形如 "a -> b" 不会命中白名单）。
    const offenders = dirty
      .split(/\r?\n/)
      .map((l) => l.slice(2).trimStart())
      .filter((p) => !VERSION_FILES.has(p) && p);
    if (offenders.length) {
      for (const o of offenders) console.error(`[release] 非版本文件有未提交改动: ${o}`);
      fail('工作树有非版本文件的未提交改动，请先提交');
    }
    console.error('[release] 脏文件均为版本文件（上次发版半途遗留），续跑将覆盖重算为一致值，继续。');
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
    'package-lock.json',
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
  if (!existsSync(nsis)) fail(`找不到 NSIS 安装包: ${nsis}`);
  if (!existsSync(sig)) {
    fail(`找不到签名文件: ${sig}。请确认已设置 TAURI_SIGNING_PRIVATE_KEY_PATH / TAURI_SIGNING_PRIVATE_KEY（本仓密钥路径: ${defaultKeyPath()}）`);
  }
  // 仅 NSIS 单通道（MSI 已弃：core/prompts/ 中文目录名超出 WiX 1252 码页）。
  const files = [nsis, sig];
  return { nsis, sig, files };
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
  const { target, notes, skipBuild, dryRun, repo: repoArg } = parseArgv(process.argv.slice(2));
  assertCleanWorktree();
  const before = currentVersion();
  const version = bumpVersion(before, target);
  const repo = repoArg || detectRepo();

  // 自增防呆：显式指定版本时 target === version；自增模式（patch/minor/major）算出的版本若本地 tag 已存在，
  // 几乎总是发版半途续传误用自增把版本算错——拦截并提示显式版本号。显式指定不拦（幂等续传的合法路径）。
  if (target !== version
    && runCapture('git', ['tag', '-l', `v${version}`], { cwd: root }).stdout.trim() === `v${version}`) {
    fail(`自增得到 v${version} 但该 tag 已存在。若为上次发版续传，请显式指定版本号重跑: node scripts/release.mjs ${before}`);
  }

  console.log(`[release] ${before} → v${version}（repo: ${repo}${dryRun ? '，dry-run' : ''}）`);

  // dry-run：全流程无副作用演练。只读预检/凭据检查照跑；七处版本内容只在内存构造并校验，不落盘；
  // 不 build、不动 git、不碰 gh release；产物缺失降级为警告（正式运行会先构建出来），保证干净环境空跑也能通过。
  if (dryRun) {
    const writes = computeVersionWrites(version);
    verifyWrites(writes, version);
    ensureGh(repo);
    const nsisName = `novel-ws_${version}_x64-setup.exe`;
    const artifactsReady = existsSync(path.join(bundleDir, 'nsis', nsisName));
    console.log('[release] ---- dry-run 动作计划（以下均未执行）----');
    if (!skipBuild) {
      console.log('[release]   1. tauri build --ci（NSIS 单通道+签名），收集 .exe/.sig 并生成 latest.json');
    } else if (!artifactsReady) {
      console.warn(`[release]   [警告] --skip-build 但产物不存在: ${nsisName}——正式运行将在 collectArtifacts 处失败`);
    }
    console.log(`[release]   ${skipBuild ? 1 : 2}. 事务化写入 ${writes.length} 处版本文件 → check-versions 自检`);
    console.log(`[release]   ${skipBuild ? 2 : 3}. git add 七件版本文件 → commit "chore(release): bump v${version}" → tag v${version} → push origin HEAD 与 tag`);
    console.log(`[release]   ${skipBuild ? 3 : 4}. gh release create v${version} --draft → upload NSIS/sig/latest.json 共 3 资产（--clobber 幂等重试）→ edit --draft=false`);
    console.log('[release] dry-run 通过：以上为正式运行将执行的动作，本次未产生任何变更');
    return;
  }

  syncVersions(version);

  // 版本单一事实源自检：六处写入后必须一致，否则中止，防止带着漂移版本发布。
  const checkStatus = run('node', [path.join(root, 'scripts', 'check-versions.mjs')]);
  if (checkStatus !== 0) fail(`版本自检失败：check-versions.mjs 退出码 ${checkStatus}`);

  if (!skipBuild) {
    cleanBundles();
    build();
  }

  const { nsis, sig, files } = collectArtifacts(version);
  const latestPath = writeLatestJson({ version, notes, nsis, sig, repo });
  files.push(latestPath);

  ensureGh(repo);
  commitAndPush(version);
  uploadRelease(repo, version, notes, files);

  console.log('[release] 完成。');
  console.log(`  Release: https://github.com/${repo}/releases/tag/v${version}`);
  console.log(`  latest.json: https://github.com/${repo}/releases/latest/download/latest.json`);
  console.log(`  NSIS: https://github.com/${repo}/releases/download/v${version}/${path.basename(nsis)}`);
}

main();
