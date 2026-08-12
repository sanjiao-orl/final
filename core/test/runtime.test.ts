// 测试：进程握手（D2）——ready 行与 core-runtime.local.json 携带版本/commit/协议自报，字段齐全。
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, readyLine, writeRuntimeFile, type RuntimeInfo } from '../src/runtime.js';

const SAMPLE: RuntimeInfo = {
  port: 43210,
  token: 'tok-123',
  pid: 1234,
  startedAt: '2026-08-12T00:00:00.000Z',
  version: '0.1.0',
  commit: 'abc1234',
  protocol: PROTOCOL_VERSION,
};

describe('进程握手（D2）', () => {
  it('ready 行：单行 JSON，event=ready 且携带全部自报字段', () => {
    const line = readyLine(SAMPLE);
    expect(line.split('\n')).toHaveLength(1);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.event).toBe('ready');
    expect(parsed.port).toBe(43210);
    expect(parsed.token).toBe('tok-123');
    expect(parsed.pid).toBe(1234);
    expect(parsed.startedAt).toBe('2026-08-12T00:00:00.000Z');
    expect(parsed.version).toBe('0.1.0');
    expect(parsed.commit).toBe('abc1234');
    expect(parsed.protocol).toBe(PROTOCOL_VERSION);
  });

  it('runtime 文件：写入的 JSON 与自报字段一致（版本/commit/协议齐全，供外部消费者校验）', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'novel-runtime-test-'));
    const filePath = path.join(dir, 'core-runtime.local.json');
    writeRuntimeFile(filePath, SAMPLE);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as RuntimeInfo;
    expect(parsed).toEqual(SAMPLE);
    expect(parsed.protocol).toBe(1);
    expect(typeof parsed.commit).toBe('string');
    expect(typeof parsed.version).toBe('string');
  });
});
