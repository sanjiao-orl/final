// 模块职责：core 进程入口——解析参数、装配依赖、启动 HTTP 服务、打印/写入 token+port、孤儿守护与优雅关闭。
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Server } from 'node:http';
import {
  assertNodeVersion,
  createModelForTier,
  getGitCommit,
  getNovelDir,
  getRuntimeFilePath,
  loadLlmConfig,
  VERSION,
  type Tier,
} from './config.js';
import { connectDomainMcp } from './mcp.js';
import { createAppServer } from './server.js';
import { CandidateStore } from './candidate-store.js';
import { SessionStore } from './session-store.js';
import { PROTOCOL_VERSION, readyLine, writeRuntimeFile, type RuntimeInfo } from './runtime.js';

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

  // 配置缺失（LLM 环境变量）在启动即抛错，不静默降级。
  const llm = loadLlmConfig();
  const dbPath = path.join(getNovelDir(), 'sessions.sqlite');
  const store = new SessionStore(dbPath);
  const candidates = new CandidateStore(dbPath); // 与 sessions 同库（FK 到 sessions）
  const mcp = await connectDomainMcp(); // 连不上为 null（已 warn），聊天走无工具模式

  const token = randomUUID();
  const server = createAppServer({
    token,
    store,
    candidates,
    version: VERSION,
    chat: {
      store,
      modelForTier: (tier: Tier) => createModelForTier(llm, tier),
      tools: mcp?.tools,
    },
    rewrite: {
      modelForTier: (tier: Tier) => createModelForTier(llm, tier),
    },
  });

  await listen(server, args.port);
  const port = getPort(server);

  // 握手自报（D2）：ready 行（stdout，壳接线用）与 runtime 文件携带同一组版本/commit/协议字段，
  // 消费者按 protocol 校验兼容性（壳侧校验见 shell/src-tauri/src/lib.rs）。
  const info: RuntimeInfo = {
    port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: VERSION,
    commit: getGitCommit(),
    protocol: PROTOCOL_VERSION,
  };
  console.log(readyLine(info));
  writeRuntimeFile(getRuntimeFilePath(), info);
  console.log(`[core] 已就绪：http://127.0.0.1:${port}（/v1/dev 联调页免鉴权，其余端点需 Bearer token，协议 v${PROTOCOL_VERSION}）`);

  // 孤儿守护：每 5s 探测父进程，不在则退出。
  let orphanTimer: NodeJS.Timeout | undefined;
  if (args.parentPid) orphanTimer = startOrphanGuard(args.parentPid);

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[core] 收到 ${reason}，优雅关闭`);
    if (orphanTimer) clearInterval(orphanTimer);
    try {
      await mcp?.close();
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

function startOrphanGuard(parentPid: number): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0); // 仅探测存在性，不发送信号
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        console.warn(`[core] 父进程 ${parentPid} 已退出，孤儿守护触发退出`);
        flushAndExit(0);
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