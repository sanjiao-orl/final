// 测试：domain MCP stdio 守护——初次连接成功、子进程断开后自动退避重连并原地恢复工具集。
import { describe, expect, it, vi } from 'vitest';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDomainMcp } from '../src/mcp.js';

/** 极简 stdio transport：回应 initialize 与 tools/list，测试可手动触发 onclose 模拟子进程掉线。 */
class FakeStdioTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;
  started = 0;
  closed = 0;
  sent: Array<Record<string, unknown>> = [];

  async start(): Promise<void> {
    this.started++;
  }

  async close(): Promise<void> {
    this.closed++;
  }

  async send(message: unknown): Promise<void> {
    this.sent.push(message as Record<string, unknown>);
    const msg = message as { id?: number; method?: string };
    if (msg.method === 'initialize') {
      this.onmessage?.({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-domain', version: '1.0.0' },
        },
      });
    } else if (msg.method === 'tools/list') {
      this.onmessage?.({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'echo tool',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
          ],
        },
      });
    }
  }

  triggerClose(): void {
    this.onclose?.();
  }
}

describe('domain MCP stdio 守护', () => {
  it('子进程断开后自动重连，工具集原地恢复', async () => {
    const transports: FakeStdioTransport[] = [];
    const mcp = startDomainMcp({
      createTransport: () => {
        const transport = new FakeStdioTransport();
        transports.push(transport);
        return transport as unknown as StdioClientTransport;
      },
      backoffMs: [10, 10],
      connectTimeoutMs: 2_000,
    });
    try {
      await mcp.start();
      await vi.waitFor(() => expect(mcp.isConnected()).toBe(true));
      expect(Object.keys(mcp.tools)).toContain('echo');
      expect(transports).toHaveLength(1);

      // 模拟子进程退出/stdio 断开
      transports[0]!.triggerClose();
      expect(mcp.isConnected()).toBe(false);
      expect(Object.keys(mcp.tools)).toHaveLength(0);

      // 退避后自动重连，工具集恢复（引用不变，内容原地替换）
      await vi.waitFor(() => expect(mcp.isConnected()).toBe(true));
      expect(transports.length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(mcp.tools)).toContain('echo');
    } finally {
      await mcp.close();
    }
  });
});
