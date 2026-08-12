// e2e：真实 LLM 联调（不进单测）。LLM_API_KEY 在场则起 core 服务跑一轮真实对话（尝试工具调用）并校验落库；不在场打印跳过。
// 用法：npm run e2e -w core（需先设好 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，可选 LLM_MODEL_CHEAP）。
import { mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'novel-e2e-'));

if (!process.env.LLM_API_KEY) {
  console.log('[e2e] 跳过：未设置 LLM_API_KEY（真实 LLM 联调需要 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL）');
  process.exit(0);
}
if (!process.env.LLM_BASE_URL || !process.env.LLM_MODEL) {
  console.error('[e2e] 缺少 LLM_BASE_URL 或 LLM_MODEL，无法启动 core（core 启动时校验三要素）');
  process.exit(1);
}

// ---- 起 core 服务 ----
// 不经 npx：Windows 下 npx 是 .cmd，Node 直接 spawn 会被 EINVAL 拦（CVE-2024-27980）。
// 直接用当前 node 跑 tsx 的 cli 入口（workspaces 提升后在根 node_modules）。
import { existsSync } from 'node:fs';
const tsxCli = [path.join(coreDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(coreDir, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')].find(existsSync);
if (!tsxCli) {
  console.error('[e2e] 找不到 tsx cli 入口（core/node_modules 或根 node_modules）');
  process.exit(1);
}
const child = spawn(process.execPath, [tsxCli, 'src/main.ts'], {
  cwd: coreDir,
  env: { ...process.env, NOVEL_DIR: path.join(tmpDir, '.novel'), CORE_RUNTIME_FILE: path.join(tmpDir, 'runtime.json') },
  stdio: ['ignore', 'pipe', 'inherit'],
});

let baseUrl;
let token;
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('core 60s 内未就绪')), 60_000);
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const line = buf.split('\n').find((l) => l.includes('"event":"ready"'));
    if (line) {
      clearTimeout(timer);
      try {
        const info = JSON.parse(line);
        baseUrl = `http://127.0.0.1:${info.port}`;
        token = info.token;
        resolve();
      } catch (err) {
        reject(err);
      }
    }
  });
  child.once('exit', (code) => reject(new Error(`core 提前退出，code=${code}`)));
});
await ready;
console.log(`[e2e] core 已就绪：${baseUrl}`);

// ---- 真实对话一轮，提示模型调用领域工具 ----
// workDir 必须是绝对路径（domain 路径守卫拒绝相对路径），用仓内演示作品。
const demoWorkDir = path.resolve(coreDir, '..', '.demo-work').replaceAll('\\', '/');
const prompt =
  `请先调用 word_count 工具统计作品一章的字数（workDir="${demoWorkDir}"，relPath="manuscript/第一卷·风起/第一章·少年.md"），` +
  '然后把工具返回的数字写进一句话回复里。';

const events = [];
const res = await fetch(`${baseUrl}/v1/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ text: prompt, tier: 'writing' }),
});
if (!res.ok) throw new Error(`/v1/chat 返回 ${res.status}: ${await res.text()}`);

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const raw = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.startsWith('event:')) event = t.slice(6).trim();
      else if (t.startsWith('data:')) dataLines.push(t.slice(5).trim());
    }
    if (dataLines.length) events.push({ event, data: JSON.parse(dataLines.join('\n')) });
  }
}

const toolCalls = events.filter((e) => e.event === 'tool-call');
const done = events.filter((e) => e.event === 'done');
const errors = events.filter((e) => e.event === 'error');
const text = events.filter((e) => e.event === 'text-delta').map((e) => e.data.delta).join('');
console.log(`[e2e] 事件统计: text-delta=${events.filter((e) => e.event === 'text-delta').length}, tool-call=${toolCalls.length}, done=${done.length}, error=${errors.length}`);
if (text) console.log(`[e2e] 回复片段: ${text.slice(0, 200)}`);

if (errors.length) throw new Error(`[e2e] 服务端错误事件: ${JSON.stringify(errors[0].data)}`);
if (done.length !== 1) throw new Error('[e2e] 未收到 done 事件');
if (toolCalls.length === 0) {
  console.warn('[e2e] 警告：本轮没有工具调用（domain MCP 未就绪或模型未触发），其余链路正常');
}

// ---- 校验落库 ----
const sessionsRes = await fetch(`${baseUrl}/v1/sessions`, { headers: { Authorization: `Bearer ${token}` } });
const { sessions } = await sessionsRes.json();
const sessionId = done[0].data.sessionId;
if (!sessions.some((s) => s.id === sessionId)) throw new Error('[e2e] 会话未落库');
const detailRes = await fetch(`${baseUrl}/v1/sessions/${sessionId}`, { headers: { Authorization: `Bearer ${token}` } });
const { messages } = await detailRes.json();
if (messages.length < 2) throw new Error('[e2e] 消息未落库完整');
const assistantMsg = messages[messages.length - 1];
console.log(`[e2e] 落库校验通过：session=${sessionId}，消息 ${messages.length} 条，assistant toolCalls=${assistantMsg.toolCalls.length}`);

// ---- 优雅关闭 ----
// Windows 无 SIGTERM：child.kill 走 TerminateProcess，exit code 必为 null（signal='SIGTERM'），属预期。
child.kill('SIGTERM');
const exitCode = await new Promise((resolve) => child.once('exit', (code) => resolve(code)));
if (exitCode !== 0 && !(process.platform === 'win32' && exitCode === null)) {
  throw new Error(`[e2e] core 退出码异常: ${exitCode}`);
}
console.log('[e2e] 通过（core 已退出）');
