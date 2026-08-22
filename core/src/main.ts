// 模块职责：core 进程入口——解析参数、装配依赖、启动 HTTP 服务、打印/写入 token+port、孤儿守护与优雅关闭。
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Server } from 'node:http';
import {
  assertNodeVersion,
  backupSqliteFile,
  getGitCommit,
  getNovelDir,
  getRuntimeFilePath,
  modelForPurpose,
  VERSION,
  type Tier,
} from './config.js';
import { startDomainMcp } from './mcp.js';
import { createAppServer } from './server.js';
import { CandidateStore } from './candidate-store.js';
import { SessionStore } from './session-store.js';
import { StatsStore } from './stats-store.js';
import { PROTOCOL_VERSION, readyLine, writeRuntimeFile, type RuntimeInfo } from './runtime.js';

/** esbuild 构建时注入的 git 短 commit（与 server.ts 同款判定模式）：tsx dev 未定义 → /v1/dev 联调页开；prod bundle 注入 → 关。 */
declare const __CORE_COMMIT__: string | undefined;

interface CliArgs {
  port: number | undefined;
  parentPid: number | undefined;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { port: undefined, parentPid: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error('--port 取值非法');
      args.port = value;
      i++;
    } else if (argv[i] === '--parent-pid') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) throw new Error('--parent-pid 取值非法');
      args.parentPid = value;
      i++;
    } else {
      throw new Error(`未知参数: ${argv[i]}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  // Node 版本门禁（D2）：低于下限直接拒启，不给半坏运行状态。
  assertNodeVersion();

  const args = parseArgs(process.argv.slice(2));

  // 配置缺失（LLM 环境变量/预设）在启动即抛错，不静默降级；三种用途各触一次，把错误暴露在启动期并预热模型缓存。
  modelForPurpose(process.env, 'writing');
  modelForPurpose(process.env, 'background');
  modelForPurpose(process.env, 'review');
  const dbPath = path.join(getNovelDir(), 'sessions.sqlite');
  // 启动冷备份（打开库之前）：库已存在则滚动拷贝一份 sessions.sqlite.bak（单份覆盖）；失败只 warn 不阻断启动。
  backupSqliteFile(dbPath);
  const store = new SessionStore(dbPath);
  const candidates = new CandidateStore(dbPath); // 与 sessions 同库（FK 到 sessions）
  const stats = new StatsStore(dbPath);
  const mcp = startDomainMcp(); // 连不上自动重连（已 warn）；重连期间工具代理回 503
  await mcp.start();

  const token = randomUUID();
  // /v1/dev 联调页开关：tsx dev 运行时开、prod bundle 关（与 server.ts 的 devEnabledDefault 同款缺省判定），
  // 显式传入让门禁与 ready 行日志保持一致。
  const devEnabled = typeof __CORE_COMMIT__ === 'undefined';
  const server = createAppServer({
    token,
    store,
    candidates,
    stats,
    version: VERSION,
    devEnabled,
    chat: {
      store,
      candidates,
      modelForTier: (tier: Tier) => modelForPurpose(process.env, tier),
      tools: mcp.tools,
      toolsAvailable: () => mcp.isConnected(),
    },
    rewrite: {
      modelForTier: (tier: Tier) => modelForPurpose(process.env, tier),
    },
    continue: {
      modelForTier: () => modelForPurpose(process.env, 'background'),
    },
    summary: {
      modelForTier: () => modelForPurpose(process.env, 'background'),
      tools: mcp.tools,
    },
    qualityCheck: {
      modelForTier: () => modelForPurpose(process.env, 'background'),
      tools: mcp.tools,
    },
  });

  // listen 失败（如端口占用）会走 main().catch 直接 process.exit——而此时 runtime 文件尚未写入
  //（writeRuntimeFile 只在 listen 成功后、ready 行之前执行，见下方），故无 core-runtime.local.json 残留需清理。
  await listen(server, args.port);
  const port = getPort(server);

  // 握手自报（D2）：先落盘 runtime 文件、成功后才打印 ready 行——壳解析到 ready 即认为 core 已就绪，
  // 两者携带同一组版本/commit/协议字段，消费者按 protocol 校验兼容性（壳侧校验见 shell/src-tauri/src/lib.rs）。
  const info: RuntimeInfo = {
    port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: VERSION,
    commit: getGitCommit(),
    protocol: PROTOCOL_VERSION,
  };
  writeRuntimeFile(getRuntimeFilePath(), info);
  console.log(readyLine(info));
  // ready 行日志如实：dev 下联调页开着才声称免鉴权；prod bundle 下该页已关闭，不再提它。
  console.log(
    devEnabled
      ? `[core] 已就绪：http://127.0.0.1:${port}（/v1/dev 联调页免鉴权，其余端点需 Bearer token，协议 v${PROTOCOL_VERSION}）`
      : `[core] 已就绪：http://127.0.0.1:${port}（其余端点需 Bearer token，协议 v${PROTOCOL_VERSION}）`
  );

  // 孤儿守护：每 5s 探测父进程，不在则退出。
  let orphanTimer: NodeJS.Timeout | undefined;
  if (args.parentPid) {
    orphanTimer = startOrphanGuard(args.parentPid, () => {
      // 孤儿退出走完整 shutdown（关 MCP/store/runtime/server）再退出，避免直接 process.exit 泄漏连接或 DB 句柄；
      // 兜底：shutdown 内部若卡住（如 mcp.close 挂起），3s 后强退，不让孤儿进程常驻。
      const force = setTimeout(() => process.exit(0), 3_000);
      force.unref();
      void shutdown('父进程退出（孤儿守护）');
    });
  }

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[core] 收到 ${reason}，优雅关闭`);
    if (orphanTimer) clearInterval(orphanTimer);
    try {
      await mcp.close();
    } catch {
      // 忽略关闭失败
    }
    try {
      store.close();
    } catch {
      // 忽略关闭失败
    }
    try {
      candidates.close();
    } catch {
      // 忽略关闭失败
    }
    try {
      stats.close();
    } catch {
      // 忽略关闭失败
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    flushAndExit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function listen(server: Server, port: number | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? 0, '127.0.0.1', () => resolve());
  });
}

function getPort(server: Server): number {
  const address = server.address();
  if (typeof address === 'object' && address) return address.port;
  throw new Error('无法获取监听端口');
}

function startOrphanGuard(parentPid: number, onOrphan: () => void): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0); // 仅探测存在性，不发送信号
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        console.warn(`[core] 父进程 ${parentPid} 已退出，孤儿守护触发退出`);
        onOrphan();
      }
      // EPERM 等：进程仍在（可能权限不同），继续存活
    }
  }, 5_000);
  timer.unref();
  return timer;
}

/** 先 flush 掉挂起的 stdout（如 ready 行）再退出，避免管道模式下丢输出。 */
function flushAndExit(code: number): void {
  process.stdout.write('', () => process.exit(code));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[core] 启动失败: ${message}`);
  process.exit(1);
});