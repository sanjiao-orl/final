// 模块职责：连接 domain MCP 服务（stdio 子进程），取出工具集供聊天管道注入；连不上则降级为无工具并自动重连（不致命）。
// 每个工具 execute 注入请求级超时（AbortSignal 合并，@ai-sdk/mcp 的 request 收到 abort 即拒绝该次 stdio 请求；
// SDK 同时发送 notifications/cancelled，domain 侧长循环经 extra.signal 中断，不再空跑到底）；
// 连接后定时活性探测（listTools 短超时探针），连续失败判定 domain 僵死并走同一套断开→退避重连，isConnected 因此反映真实活性而非仅管道存活。
import path from 'node:path';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolSet } from 'ai';
import { getDomainMcpCommand, getToolTimeoutSeconds } from './config.js';

export interface DomainMcp {
  /** 当前工具集（同一引用，重连成功后原地替换内容，HTTP 层拿到的引用不变）。 */
  readonly tools: ToolSet;
  /** 当前是否已连接且活性探测未判僵死；false 表示降级/重连中，工具代理据此回 503 而非 404。 */
  isConnected(): boolean;
  /** 首次连接；失败不抛错（已 warn 并自动进入重连）。 */
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface DomainMcpOptions {
  /** 测试注入：创建 stdio transport；缺省用真实 StdioClientTransport 拉起 domain 子进程。 */
  createTransport?: () => StdioClientTransport;
  /** 重连退避序列（毫秒），指数递增、越界取末位（即上限）。 */
  backoffMs?: readonly number[];
  connectTimeoutMs?: number;
  /** 工具请求级超时（毫秒）：注入每个工具 execute 的合并 abort 信号；缺省取 config.getToolTimeoutSeconds()*1000。 */
  toolRequestTimeoutMs?: number;
  /** 活性探测间隔（毫秒）；0 关闭探测。 */
  watchdogIntervalMs?: number;
  /** 单次活性探测（listTools）超时（毫秒）。 */
  watchdogTimeoutMs?: number;
  /** 连续探测失败多少次判定 domain 僵死并重连。 */
  watchdogFailureThreshold?: number;
}

const CONNECT_TIMEOUT_MS = 15_000;
/** 重连退避序列（毫秒）：1s 起步翻倍，封顶 60s——domain 命令永久损坏时不再固定间隔无限刷屏。 */
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000] as const;

/** 活性探测缺省口径：15s 一探、10s 探测超时、连续 2 次失败判僵死。 */
const WATCHDOG_INTERVAL_MS = 15_000;
const WATCHDOG_TIMEOUT_MS = 10_000;
const WATCHDOG_FAILURE_THRESHOLD = 2;

/**
 * 启动 domain MCP 连接并持续守护：子进程退出/传输错误/活性探测判僵死后按指数退避序列（带上限）自动重连，
 * 重连成功会把 tools 对象原地替换为新工具集。命令缺省 "npx tsx ../domain/src/server.ts"。
 */
export function startDomainMcp(options: DomainMcpOptions = {}): DomainMcp {
  const { command, args } = getDomainMcpCommand();
  // domain 子进程环境：只叠加必需变量，不再整份透传 process.env（会带出 LLM_API_KEY 等秘密）。
  // StdioClientTransport 未显式给 env 时已用 getDefaultEnvironment()（PATH/SystemRoot/TEMP 等启动必需）；
  // 这里只在设置了 NOVEL_PROMPT_DIR 时补这一个变量，其余一律不传。
  const domainEnv =
    process.env.NOVEL_PROMPT_DIR !== undefined
      ? { NOVEL_PROMPT_DIR: process.env.NOVEL_PROMPT_DIR }
      : undefined;
  const createTransport =
    options.createTransport ??
    (() =>
      new StdioClientTransport({
        command,
        args,
        cwd: path.resolve(import.meta.dirname, '..'),
        ...(domainEnv ? { env: domainEnv } : {}),
        stderr: 'inherit',
      }));
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const toolRequestTimeoutMs = options.toolRequestTimeoutMs ?? getToolTimeoutSeconds() * 1000;
  const watchdogIntervalMs = options.watchdogIntervalMs ?? WATCHDOG_INTERVAL_MS;
  const watchdogTimeoutMs = options.watchdogTimeoutMs ?? WATCHDOG_TIMEOUT_MS;
  const watchdogFailureThreshold = options.watchdogFailureThreshold ?? WATCHDOG_FAILURE_THRESHOLD;

  const tools: ToolSet = {};
  let connected = false;
  let stopped = false;
  let generation = 0;
  let attempt = 0;
  let client: MCPClient | undefined;
  let transport: StdioClientTransport | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let watchdogTimer: NodeJS.Timeout | undefined;
  let watchdogFailures = 0;

  /** 工具 execute 的最小调用口径（@ai-sdk/mcp 生成的工具只经由 abortSignal 影响底层 stdio 请求）。 */
  type RawExecute = (input: never, opts: { abortSignal?: AbortSignal }) => Promise<unknown>;

  function replaceTools(next: ToolSet): void {
    const wrapped: ToolSet = {};
    for (const [name, nextTool] of Object.entries(next)) {
      const rawExecute = (nextTool as { execute?: unknown }).execute;
      if (typeof rawExecute !== 'function') {
        wrapped[name] = nextTool;
        continue;
      }
      // 请求级超时：把调用方 signal 与固定超时合并后透传——@ai-sdk/mcp 的 request 收到 abort 即
      // 拒绝该次 stdio 请求，工具挂起不再无限等 domain 回包（此前仅建连有超时，请求零 watchdog）。
      const run = rawExecute as RawExecute;
      wrapped[name] = {
        ...nextTool,
        execute: async (input: never, opts?: { abortSignal?: AbortSignal }) => {
          const timeoutSignal = AbortSignal.timeout(toolRequestTimeoutMs);
          const merged = opts?.abortSignal ? AbortSignal.any([opts.abortSignal, timeoutSignal]) : timeoutSignal;
          return await run(input, { ...opts, abortSignal: merged });
        },
      } as typeof nextTool;
    }
    for (const key of Object.keys(tools)) delete tools[key];
    Object.assign(tools, wrapped);
  }

  function clearTools(): void {
    for (const name of Object.keys(tools)) delete tools[name];
  }

  function stopWatchdog(): void {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = undefined;
    }
  }

  function startWatchdog(): void {
    stopWatchdog();
    watchdogFailures = 0;
    if (watchdogIntervalMs <= 0) return;
    watchdogTimer = setInterval(() => void probeLiveness(), watchdogIntervalMs);
    watchdogTimer.unref();
  }

  /**
   * 活性探测：短超时 listTools 当 ping。成功清零失败计数；失败累计到阈值即判定 domain 僵死
   * （进程活着但不再应答），走同一套断开→重连，让 isConnected/503 保护反映真实活性。
   */
  async function probeLiveness(): Promise<void> {
    const currentClient = client;
    if (stopped || !currentClient || !connected) return;
    const generationAtProbe = generation;
    try {
      await currentClient.listTools({ options: { timeout: watchdogTimeoutMs } });
    } catch (err) {
      if (stopped || generation !== generationAtProbe) return; // 已在重连/关闭流程，别重复处理
      watchdogFailures++;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[core] domain MCP 活性探测失败（${watchdogFailures}/${watchdogFailureThreshold}）：${message}`);
      if (watchdogFailures >= watchdogFailureThreshold) {
        await handleDisconnect(`连续 ${watchdogFailures} 次活性探测失败（疑似僵死）`);
      }
      return;
    }
    watchdogFailures = 0;
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? DEFAULT_BACKOFF_MS[DEFAULT_BACKOFF_MS.length - 1];
    attempt++;
    console.warn(`[core] domain MCP 将在 ${delay}ms 后重连（第 ${attempt} 次）`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
    reconnectTimer.unref();
  }

  async function closeCurrent(): Promise<void> {
    stopWatchdog();
    const oldClient = client;
    const oldTransport = transport;
    client = undefined;
    transport = undefined;
    connected = false;
    if (oldTransport) {
      delete oldTransport.onclose;
      delete oldTransport.onerror;
    }
    if (oldClient) {
      try {
        await oldClient.close();
      } catch {
        // 忽略关闭失败
      }
    } else if (oldTransport) {
      try {
        await oldTransport.close();
      } catch {
        // 忽略关闭失败
      }
    }
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    const currentGeneration = ++generation;
    const nextTransport = createTransport();
    transport = nextTransport;
    try {
      const nextClient = await withTimeout(
        createMCPClient({ transport: nextTransport }),
        connectTimeoutMs,
        'MCP 初始化超时'
      );
      if (stopped || generation !== currentGeneration) {
        try {
          await nextClient.close();
        } catch {
          // 忽略关闭失败
        }
        return;
      }
      const definitions = await withTimeout(nextClient.listTools(), connectTimeoutMs, 'MCP listTools 超时');
      if (stopped || generation !== currentGeneration) {
        try {
          await nextClient.close();
        } catch {
          // 忽略关闭失败
        }
        return;
      }

      // 接管 transport 的关闭回调：子进程退出/stdio 断开会触发这里，安排重连。
      nextTransport.onclose = () => {
        void handleDisconnect('连接断开');
      };
      // 缺陷台账 mcp.ts:143：onerror 空实现不留日志不重连。这里记 warn 并触发同一套断开处理
      //（onclose 未跟上也能重连；两事件并发时 handleDisconnect 的 connected 守卫保证只处理一次）。
      nextTransport.onerror = (error: Error) => {
        console.warn(`[core] domain MCP 传输错误: ${error instanceof Error ? error.message : String(error)}`);
        void handleDisconnect('传输错误');
      };
      client = nextClient;
      replaceTools(nextClient.toolsFromDefinitions(definitions));
      connected = true;
      attempt = 0;
      startWatchdog();
      console.log('[core] domain MCP 已连接');
    } catch (err) {
      if (stopped || generation !== currentGeneration) return;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[core] 无法连接 domain MCP 服务（${message}），将自动重连`);
      if (transport === nextTransport) transport = undefined;
      try {
        delete nextTransport.onclose;
        delete nextTransport.onerror;
        await nextTransport.close();
      } catch {
        // 忽略关闭失败
      }
      scheduleReconnect();
    }
  }

  async function handleDisconnect(reason: string): Promise<void> {
    if (stopped || !connected) return;
    connected = false; // 先落标志：onerror→onclose 并发到达时只处理一次
    generation++;
    clearTools();
    stopWatchdog();
    await closeCurrent();
    console.warn(`[core] domain MCP ${reason}，将自动重连`);
    scheduleReconnect();
  }

  async function start(): Promise<void> {
    await connect();
  }

  async function close(): Promise<void> {
    stopped = true;
    generation++;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    stopWatchdog();
    clearTools();
    await closeCurrent();
  }

  return {
    tools,
    isConnected: () => connected,
    start,
    close,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
