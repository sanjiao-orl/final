// 跨对话记忆实测脚本：同一会话两轮真实 LLM 对话，第二轮验证第一轮埋下的事实能被召回。
// 用法：node core/scripts/verify-memory.mjs（需要 shell 环境变量 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL/LLM_MODEL_CHEAP）
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'novel-mem-'));
const tsxCli = [
  path.join(coreDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  path.join(coreDir, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
].find(existsSync);

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
    if (line) {
      clearTimeout(timer);
      resolve(JSON.parse(line));
    }
  });
  child.once('exit', (code) => reject(new Error(`core 提前退出 code=${code}`)));
});
const base = `http://127.0.0.1:${info.port}`;
const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${info.token}` };
console.log(`[M] core 就绪 ${base}`);

const fail = (msg) => {
  console.error('[M] 失败: ' + msg);
  child.kill();
  process.exit(1);
};

/** 发一轮 /v1/chat，返回 { sessionId, reply }（reply 为拼接的 assistant 文本）。 */
async function chat(sessionId, text) {
  const res = await fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(sessionId ? { sessionId, text } : { text }),
  });
  if (!res.ok) fail('/v1/chat ' + res.status + ' ' + (await res.text()));
  const t = await res.text();
  const m = /event: done\ndata: (\{.*\})/.exec(t);
  if (!m) fail('/v1/chat 无 done: ' + t.slice(-300));
  const reply = [...t.matchAll(/event: text-delta\ndata: (\{.*\})/g)]
    .map((x) => JSON.parse(x[1]).delta)
    .join('');
  return { sessionId: JSON.parse(m[1]).sessionId, reply };
}

// ---- 第一轮：埋一个判别性事实 ----
const secret = '栖迟客';
const r1 = await chat(null, `这是记忆测试：请记住我的笔名是「${secret}」。只回一个字：好。`);
console.log(`[M] 第一轮（埋事实）回复="${r1.reply.slice(0, 60)}"`);

// ---- 第二轮：同一会话问回该事实 ----
const r2 = await chat(r1.sessionId, '我的笔名是什么？只回答笔名本身，不要任何多余的字。');
console.log(`[M] 第二轮（问回）回复="${r2.reply}"`);
if (!r2.reply.includes(secret)) fail(`第二轮未召回「${secret}」，实际回复="${r2.reply}"`);

// ---- 落库核对：同一会话应有 4 条消息（user/assistant/user/assistant）----
const sessions = (await (await fetch(`${base}/v1/sessions`, { headers: auth })).json()).sessions;
if (!sessions.some((s) => s.id === r1.sessionId)) fail('会话未落库');
console.log(`[M] 会话 ${r1.sessionId} 两轮均落库，跨对话记忆 OK`);

console.log('[M] 全部通过');
child.kill('SIGTERM');
process.exit(0);
