// 测试：domain MCP stdio 守护——初次连接成功、子进程断开后自动退避重连并原地恢复工具集；
// 另覆盖请求级超时、活性探测判僵死重连、传输错误留日志触发重连、退避序列递增带上限。
import { describe, expect, it, vi } from 'vitest';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDomainMcp, type DomainMcpOptions } from '../src/mcp.js';

/** 极简 stdio transport：回应 initialize 与 tools/list，测试可手动触发 onclose/onerror 模拟子进程掉线/传输出错。 */
class FakeStdioTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;
  started = 0;
  closed = 0;
  sent: Array<Record<string, unknown>> = [];
  /** 模拟 domain 僵死：tools/list 不回应（活性探测超时）。 */
  muteList = false;
  /** 模拟工具调用挂起：tools/call 不回应（请求级超时兜底）。 */
  muteCall = false;

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
      if (this.muteList) return;
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
    } else if (msg.method === 'tools/call') {
      if (this.muteCall) return;
      this.onmessage?.({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: '{"echoed":true}' }] },
      });
    }
  }

  triggerClose(): void {
    this.onclose?.();
  }

  triggerError(): void {
    this.onerror?.(new Error('模拟传输错误'));
  }
}

/** 永远连不上的 transport（start 即抛）：测退避序列。 */
class BrokenTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;
  async start(): Promise<void> {
    throw new Error('命令损坏');
  }
  async close(): Promise<void> {}
  async send(): Promise<void> {}
}

function makeOptions(
  transports: FakeStdioTransport[],
  overrides: Partial<DomainMcpOptions> = {}
): DomainMcpOptions {
  return {
    createTransport: () => {
      const transport = new FakeStdioTransport();
      transports.push(transport);
      return transport as unknown as StdioClientTransport;
    },
    backoffMs: [5, 5],
    connectTimeoutMs: 2_000,
    ...overrides,
  };
}

describe('domain MCP stdio 守护', () => {
  it('子进程断开后自动重连，工具集原地恢复', async () => {
    const transports: FakeStdioTransport[] = [];
    const mcp = startDomainMcp(makeOptions(transports));
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

  it('transport.onerror 留 warn 日志并触发重连（不再空实现）', async () => {
    const transports: FakeStdioTransport[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mcp = startDomainMcp(makeOptions(transports));
    try {
      await mcp.start();
      await vi.waitFor(() => expect(mcp.isConnected()).toBe(true));

      transports[0]!.triggerError();
      expect(mcp.isConnected()).toBe(false);
      expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('domain MCP 传输错误'))).toBe(true);

      await vi.waitFor(() => expect(mcp.isConnected()).toBe(true));
      expect(transports.length).toBeGreaterThanOrEqual(2);
    } finally {
      warnSpy.mockRestore();
      await mcp.close();
    }
  });

  it('工具 execute 自带请求级超时：正常应答照常返回，无响应时快速失败而非永挂', async () => {
    const transports: FakeStdioTransport[] = [];
    const mcp = startDomainMcp(makeOptions(transports, { toolRequestTimeoutMs: 80 }));
    try {
      await mcp.start();
      await vi.waitFor(() => expect(mcp.isConnected()).toBe(true));
      const execute = (
        mcp.tools.echo as unknown as { execute: (input: unknown, options: unknown) => Promise<unknown> }
      ).execute;

      // 正常应答路径不受影响
      const ok = await execute({ text: 'hi' }, { toolCallId: 't1', messages: [], context: undefined });
      expect(ok).toEqual({ isError: false, content: [{ type: 'text', text: '{"echoed":true}' }] });

      // domain 不应答 → 注入的合并 abortSignal 让底层请求快速拒绝
      transports[transports.length - 1]!.muteCall = true;
      const startedAt = Date.now();
      await expect(
        execute({ text: 'x' }, { toolCallId: 't2', messages: [], context: undefined })
      ).rejects.toThrow(/Request was aborted|timed out|aborted/i);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      await mcp.close();
    }
  });

  it('domain 僵死（tools/list 无响应）经活性探测判定断开，随后自动重连恢复', async () => {
    const transports: FakeStdioTransport[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mcp = startDomainMcp(
      makeOptions(transports, { watchdogIntervalMs: 20, watchdogTimeoutMs: 60, watchdogFailureThreshold: 2 })
    );
    try {
      await mcp.start();
      await vi.waitFor(() => expect(mcp.isConnected()).toBe(true));

      // 当前 domain 停止应答 tools/list（僵死非崩溃：管道仍在）
      transports[transports.length - 1]!.muteList = true;
      // 连续两次探测失败（各 60ms 超时）→ 判定僵死。断开窗口是瞬态（退避仅 5ms 即重连成功），
      // 故经由日志与 transport 数观察，而非轮询瞬态的 isConnected=false。
      await vi.waitFor(() => {
        const joined = warnSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
        expect(joined).toContain('连续 2 次活性探测失败（疑似僵死）');
        expect(joined).toContain('活性探测失败（1/2）');
        expect(joined).toContain('活性探测失败（2/2）');
      }, { timeout: 3_000 });

      // 新 transport 正常应答 → 自动重连，工具恢复，且探测恢复正常后不再误杀新连接
      await vi.waitFor(() => {
        expect(transports.length).toBeGreaterThanOrEqual(2);
        return undefined;
      }, { timeout: 3_000 });
      await vi.waitFor(() => {
        expect(mcp.isConnected()).toBe(true);
        expect(Object.keys(mcp.tools)).toContain('echo');
        return undefined;
      }, { timeout: 3_000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mcp.isConnected()).toBe(true);
    } finally {
      warnSpy.mockRestore();
      await mcp.close();
    }
  });

  it('重连退避按序列递增且越界取末位（上限封顶，不无限刷屏同间隔）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let brokenCount = 0;
    const mcp = startDomainMcp({
      createTransport: () => {
        brokenCount++;
        return new BrokenTransport() as unknown as StdioClientTransport;
      },
      backoffMs: [10, 20, 40],
      connectTimeoutMs: 500,
    });
    try {
      await mcp.start();
      // 首连 + 三次重连全部失败 → 记录到 4 个退避延迟（第 4 次起越界取末位 40ms）
      await vi.waitFor(() => {
        const delays = warnSpy.mock.calls
          .map((call) => /将在 (\d+)ms 后重连/.exec(String(call[0]))?.[1])
          .filter(Boolean);
        expect(delays).toEqual(['10', '20', '40', '40']);
      }, { timeout: 3_000 });
      expect(brokenCount).toBeGreaterThanOrEqual(4);
    } finally {
      warnSpy.mockRestore();
      await mcp.close();
    }
  });
});
