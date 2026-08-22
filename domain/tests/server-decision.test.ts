/**
 * server-decision.test.ts —— decision_append 裁决词表别名归一（server.ts zod 层）集成测试：
 * 起 stdio MCP client 连真实 domain server（tsx spawn src/server.ts），验证碰撞协议词
 * 「放行/打回」（core/prompts/collide.md 口径）登记时自动归一为「采纳/驳回」落盘、
 * 搁置原样透传、非法词仍被枚举拒绝。zod 归一层在 server.ts，单测打不到，故走真管道。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeWorkDir } from './helpers.js';

const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve('tsx/cli');
const SERVER_ENTRY = path.resolve(import.meta.dirname, '..', 'src', 'server.ts');

/** 惰性起一个共享的 domain server（tsx 冷启动有成本，整个文件复用一条连接）。 */
let client: Client | null = null;
async function getClient(): Promise<Client> {
  if (client) return client;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, SERVER_ENTRY],
  });
  client = new Client({ name: 'domain-test-client', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

afterAll(async () => {
  await client?.close();
  client = null;
});

function callArgs(workDir: string, ruling: string) {
  return {
    name: 'decision_append' as const,
    arguments: {
      workDir,
      topic: '人物去向',
      stance: '支持',
      ruling,
      reason: '剧情需要',
      chapters: ['第三章'],
    },
  };
}

/** 读裁决留痕全文（测试断言用）。 */
function readDecisions(work: string): string {
  return fs.readFileSync(path.join(work, 'editorial_notes', 'decisions.md'), 'utf8');
}

describe('decision_append 裁决词表别名归一（server zod 层）', () => {
  it('放行→采纳、打回→驳回、搁置原样——落盘规范词保持 采纳/驳回/搁置', { timeout: 60_000 }, async () => {
    const c = await getClient();
    for (const [alias, canonical] of [['放行', '采纳'], ['打回', '驳回'], ['搁置', '搁置']] as const) {
      const work = makeWorkDir();
      const res = await c.callTool(callArgs(work, alias));
      expect(res.isError).not.toBe(true);
      const parsed = JSON.parse((res.content as Array<{ type: string; text: string }>)[0]!.text);
      expect(parsed).toEqual({ appended: 1, id: 'D-001', path: 'editorial_notes/decisions.md' });
      expect(readDecisions(work)).toContain(`| ${canonical} |`);
      if (alias !== canonical) expect(readDecisions(work)).not.toContain(`| ${alias} |`);
    }
  });

  it('非法裁决词仍被枚举拒绝（isError 且不落盘）', { timeout: 60_000 }, async () => {
    const c = await getClient();
    const work = makeWorkDir();
    const res = await c.callTool(callArgs(work, '无效裁决'));
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('采纳');
    expect(fs.existsSync(path.join(work, 'editorial_notes'))).toBe(false);
  });
});
