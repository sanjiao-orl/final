// 模块职责：连接 domain MCP 服务（stdio 子进程），取出工具集供聊天管道注入；连不上则降级为无工具并自动重连（不致命）。
import path from 'node:path';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolSet } from 'ai';
import { getDomainMcpCommand } from './config.js';

export interface DomainMcp {
  /** 当前工具集（同一引用，重连成功后原地替换内容，HTTP 层拿到的引用不变）。 */
  readonly tools: ToolSet;
  /** 当前是否已连接；false 表示降级/重连中，工具代理据此回 503 而非 404。 */
  isConnected(): boolean;
  /** 首次连接；失败不抛错（已 warn 并自动进入重连）。 */
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface DomainMcpOptions {
  /** 测试注入：创建 stdio transport；缺省用真实 StdioClientTransport 拉起 domain 子进程。 */
  createTransport?: () => StdioClientTransport;
  /** 重连退避序列（毫秒），越界取末位。 */
  backoffMs?: readonly number[];
  connectTimeoutMs?: number;
}

const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000] as const;

/**
 * 启动 domain MCP 连接并持续守护：子进程退出/传输关闭后按退避序列自动重连，
 * 重连成功会把 tools 对象原地替换为新工具集。命令缺省 "npx tsx ../domain/src/server.ts"。
 */
export function startDomainMcp(options: DomainMcpOptions = {}): DomainMcp {
  const { command, args } = getDomainMcpCommand();
  const createTransport =
    options.createTransport ??
    (() =>
      new StdioClientTransport({
        command,
        args,
        cwd: path.resolve(import.meta.dirname, '..'),
        stderr: 'inherit',
      }));
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

  const tools: ToolSet = {};
  let connected = false;
  let stopped = false;
  let generation = 0;
  let attempt = 0;
  let client: MCPClient | undefined;
  let transport: StdioClientTransport | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;

  function replaceTools(next: ToolSet): void {
    for (const name of Object.keys(tools)) delete tools[name];
    Object.assign(tools, next);
  }

  function clearTools(): void {
    for (const name of Object.keys(tools)) delete tools[name];
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
        void handleDisconnect();
      };
      nextTransport.onerror = () => {
        // 传输错误统一走 onclose/重连；这里仅保证有监听，避免未处理 error 崩进程。
      };
      client = nextClient;
      replaceTools(nextClient.toolsFromDefinitions(definitions));
      connected = true;
      attempt = 0;
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

  async function handleDisconnect(): Promise<void> {
    if (stopped || !connected) return;
    generation++;
    clearTools();
    await closeCurrent();
    console.warn('[core] domain MCP 连接断开，将自动重连');
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
