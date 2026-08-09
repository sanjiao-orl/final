// 验收脚本：重启恢复会话实测。固定 NOVEL_DIR 起 core → 对话一轮 → 杀进程 → 同 NOVEL_DIR 重启 → 拉取旧会话消息。
import { mkdtempSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'novel-restart-'));
const tsxCli = [path.join(coreDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(coreDir, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')].find(existsSync);

async function startCore() {
  const child = spawn(process.execPath, [tsxCli, 'src/main.ts'], {
    cwd: coreDir,
    env: { ...process.env, NOVEL_DIR: path.join(tmpDir, '.novel'), CORE_RUNTIME_FILE: path.join(tmpDir, 'runtime.json') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('core 60s 未就绪')), 60_000);
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const line = buf.split('\n').find((l) => l.includes('"event":"ready"'));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
    });
    child.once('exit', (code) => reject(new Error(`core 提前退出 code=${code}`)));
  });
  return { child, baseUrl: `http://127.0.0.1:${info.port}`, token: info.token };
}

function chatOnce(baseUrl, token) {
  return fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: '用一句话介绍你自己。' }),
  }).then(async (res) => {
    if (!res.ok) throw new Error('/chat ' + res.status);
    const text = await res.text();
    const m = /event: done\ndata: (\{.*\})/.exec(text);
    if (!m) throw new Error('没有 done 事件: ' + text.slice(-200));
    return JSON.parse(m[1]);
  });
}

const kill = (child) => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });

// 第一轮：对话落库
let c1 = await startCore();
const done = await chatOnce(c1.baseUrl, c1.token);
console.log('[restart] 第一轮对话完成 sessionId=' + done.sessionId);
await kill(c1.child);
console.log('[restart] core 已停止，模拟重启…');

// 第二轮：同 NOVEL_DIR 重启，token 已变（进程级随机），验证会话仍在
let c2 = await startCore();
const detail = await fetch(`${c2.baseUrl}/sessions/${done.sessionId}`, { headers: { Authorization: `Bearer ${c2.token}` } });
if (!detail.ok) throw new Error('重启后旧会话 404，恢复失败');
const { messages } = await detail.json();
const roles = messages.map((m) => m.role).join(',');
console.log(`[restart] 重启后旧会话消息 ${messages.length} 条（${roles}）`);
if (messages.length < 2 || messages[0].role !== 'user' || messages[1].role !== 'assistant') {
  throw new Error('重启后消息不完整');
}
console.log('[restart] 重启恢复会话：通过');
await kill(c2.child);
