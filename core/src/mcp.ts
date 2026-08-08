// 模块职责：启动时连接 domain MCP 服务（stdio 子进程），取出工具集供聊天管道注入；连不上则降级为无工具并 warn（不致命）。
import path from 'node:path';
import { createMCPClient } from '@ai-sdk/mcp';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolSet } from 'ai';
import { getDomainMcpCommand } from './config.js';

export interface DomainMcp {
  tools: ToolSet;
  close: () => Promise<void>;
}

const CONNECT_TIMEOUT_MS = 15_000;

/**
 * 连接 domain MCP 服务。成功返回 { tools, close }；失败（进程起不来、超时等）返回 null。
 * 命令缺省 "npx tsx ../domain/src/server.ts"，以 core 包目录为 cwd 解析相对路径。
 */
export async function connectDomainMcp(): Promise<DomainMcp | null> {
  const { command, args } = getDomainMcpCommand();
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: path.resolve(import.meta.dirname, '..'),
    stderr: 'inherit',
  });
  try {
    const client = await withTimeout(createMCPClient({ transport }), CONNECT_TIMEOUT_MS, 'MCP 初始化超时');
    const definitions = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, 'MCP listTools 超时');
    const tools = client.toolsFromDefinitions(definitions);
    return { tools, close: () => client.close() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[core] 无法连接 domain MCP 服务（${message}），降级为无工具模式`);
    try {
      await transport.close();
    } catch {
      // 忽略关闭失败
    }
    return null;
  }
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
