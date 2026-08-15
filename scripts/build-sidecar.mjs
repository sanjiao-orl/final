// build-sidecar.mjs —— production sidecar 打包（spike）：
// 1) 用 esbuild 把 core/domain 各自打成单文件 ESM bundle（Node≥24，node:sqlite 保持外部 builtin）；
// 2) 把本机 node 运行时复制进 shell/src-tauri/resources/sidecar/（目录内容不入库）。
// Tauri bundle.resources 再把 sidecar/ 与两个 dist 产物按固定布局收进安装包资源目录。
//
// 用法：
//   node scripts/build-sidecar.mjs             # 构建 core + domain + 复制 node
//   node scripts/build-sidecar.mjs --only core # 只构建 core（core/domain 包的 build script 用）
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : undefined;

// 构建时把当前 git 短 commit 注入 core 的 __CORE_COMMIT__ 全局（§五 prod 包自报 commit）。
// 非 git 环境/命令失败兜底 'unknown'——commit 仅自报展示，不参与协议校验。
const coreCommit = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
})();

if (only !== undefined && !['core', 'domain'].includes(only)) {
  throw new Error(`--only 只接受 core 或 domain，收到: ${only}`);
}

// esbuild 把 CJS 依赖打进来时，ESM bundle 里会剩 `require(x)` 动态 require；
// 这里注入一个基于当前文件的 createRequire，让 child_process/process 等动态 require 在 ESM 下可用。
const banner = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

async function bundlePackage(name, entryFile, outFile) {
  await build({
    entryPoints: [path.join(root, name, 'src', entryFile)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile: path.join(root, name, 'dist', outFile),
    banner: { js: banner },
    define: { __CORE_COMMIT__: JSON.stringify(coreCommit) },
    logLevel: 'info',
  });
}

if (only === undefined || only === 'core') {
  await bundlePackage('core', 'main.ts', 'main.mjs');
}

if (only === undefined || only === 'domain') {
  await bundlePackage('domain', 'server.ts', 'server.mjs');
}

if (only === undefined) {
  // 本机 node 运行时：直接复制当前 node.exe（单文件即可跑 core/domain bundle）。
  const nodeExe = process.execPath;
  const targetDir = path.join(root, 'shell', 'src-tauri', 'resources', 'sidecar');
  const targetExe = path.join(targetDir, process.platform === 'win32' ? 'node.exe' : 'node');
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  if (!existsSync(nodeExe)) {
    throw new Error(`本机 node 不存在，无法复制运行时: ${nodeExe}`);
  }
  copyFileSync(nodeExe, targetExe);
  console.log(`[build-sidecar] ${nodeExe} -> ${targetExe}`);
}
