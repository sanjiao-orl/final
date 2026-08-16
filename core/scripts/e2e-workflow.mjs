// e2e-workflow：真实写作闭环 e2e（真实 LLM，不进单测）。LLM_API_KEY 在场则起 core 服务跑一遍
// 「握手 → 起草 → 暂存候选 → 采纳 → 落章 → 快照 → 冷读审阅」闭环并逐环节校验；不在场打印跳过。
// 用法：node core/scripts/e2e-workflow.mjs（需先设好 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）。
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(coreDir, '..');

// key/URL 校验前置：缺 LLM_API_KEY 时跳过（退出码 0）、缺 URL/模型时直接报错，都不建临时目录、不复制 workDir。
if (!process.env.LLM_API_KEY) {
  console.log('[e2e-workflow] 跳过：未设置 LLM_API_KEY（真实 LLM 联调需要 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL）');
  process.exit(0);
}
if (!process.env.LLM_BASE_URL || !process.env.LLM_MODEL) {
  console.error('[e2e-workflow] 缺少 LLM_BASE_URL 或 LLM_MODEL，无法启动 core（core 启动时校验三要素）');
  process.exit(1);
}

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'novel-e2e-wf-'));
const workDirNative = path.join(tmpDir, 'work');
// workDir 沿用 e2e.mjs/verify-w3 的模式：用 .demo-work 的临时副本（不污染仓库既有内容），HTTP 侧用正斜杠。
const workDir = workDirNative.replaceAll('\\', '/');
cpSync(path.join(repoRoot, '.demo-work'), workDirNative, { recursive: true });

// 测试章节（只在临时副本里）：预建占位空壳，稍后写入采纳正文时覆盖它，正好触发「写前自动快照」。
const TEST_VOLUME = '第一卷·风起';
const TEST_TITLE = '第3章·雾夜';
const TEST_CHAPTER = `manuscript/${TEST_VOLUME}/${TEST_TITLE}.md`;

// ---- 起 core 服务 ----
// 不经 npx：Windows 下 npx 是 .cmd，Node 直接 spawn 会被 EINVAL 拦（CVE-2024-27980）。
// 直接用当前 node 跑 tsx 的 cli 入口（workspaces 提升后在根 node_modules）。
const tsxCli = [path.join(coreDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(coreDir, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')].find(existsSync);
if (!tsxCli) {
  console.error('[e2e-workflow] 找不到 tsx cli 入口（core/node_modules 或根 node_modules）');
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
try {
  await ready;
} catch (err) {
  console.error(`[e2e-workflow] core 启动失败: ${err instanceof Error ? err.message : String(err)}`);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  process.exit(1);
}
console.log(`[e2e-workflow] core 已就绪：${baseUrl}`);

// ---- 预建测试章节占位（仅临时副本内；等下采纳正文覆盖时快照旧版） ----
mkdirSync(path.join(workDirNative, 'manuscript', TEST_VOLUME), { recursive: true });
writeFileSync(
  path.join(workDirNative, ...TEST_CHAPTER.split('/')),
  `---\ntitle: ${TEST_TITLE}\nstatus: 草稿\n---\n\n（占位：待起草）\n`,
  'utf8',
);

const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

/** 单步失败：打印 FAIL 摘要、停 core、清临时目录、exit(1)。 */
function fail(stepLabel, detail) {
  console.error(`[e2e-workflow] FAIL ${stepLabel}${detail ? ' — ' + detail : ''}`);
  try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  process.exit(1);
}

/** 单步通过：打印 PASS 摘要。 */
function pass(stepLabel, detail) {
  console.log(`[e2e-workflow] PASS ${stepLabel}${detail ? ' — ' + detail : ''}`);
}

/** POST /v1/chat 并完整消费 SSE，返回事件数组 [{ event, data }]。 */
async function sseChat(body) {
  const res = await fetch(`${baseUrl}/v1/chat`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/v1/chat 返回 ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
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
  return events;
}

/** POST /v1/tools/:name 代理；MCP 重连中回 503，短退避重试（core 刚就绪时 MCP 可能还没连上）。 */
async function callTool(name, args, retries = 5) {
  for (let i = 0; ; i++) {
    const res = await fetch(`${baseUrl}/v1/tools/${name}`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(args),
    });
    if (res.status !== 503 || i >= retries) return res;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** 从章文件取正文第一段（剥 frontmatter 后首个非空段落），截断到 200 字作为候选 original 锚点。 */
function firstParagraph(relPath) {
  const content = readFileSync(path.join(workDirNative, ...relPath.split('/')), 'utf8');
  const body = content.replace(/^---[\s\S]*?---\r?\n?/, '').trim();
  const para = body.split(/\r?\n+/).find((l) => l.trim() !== '') ?? '';
  return para.trim().slice(0, 200);
}

// ---- 1/7 握手：断言 version / protocol ----
const healthRes = await fetch(`${baseUrl}/v1/health`, { headers: auth });
const health = healthRes.ok ? await healthRes.json() : null;
if (
  !healthRes.ok || health?.ok !== true ||
  typeof health?.version !== 'string' || health.version === '' ||
  typeof health?.protocol !== 'number' || health.protocol < 1
) {
  fail('1/7 握手 /v1/health', `status=${healthRes.status} body=${JSON.stringify(health)}`);
}
pass('1/7 握手 /v1/health', `version=${health.version} protocol=${health.protocol}`);

// ---- 2/7 起草：真实 LLM 按「人的方向」起草一小段章节正文 ----
const draftPrompt =
  '按「人的方向，你的笔」起草一小段章节正文：\n' +
  '方向：延续第一章《少年》的悬念——林渡夜宿客栈时听到窗外有人低声提及「青崖山」。\n' +
  '请为测试章节《第3章·雾夜》起草一段约 150~250 字的正文场景（第三人称限知、感官细节密、网文向），紧接夜宿之后。\n' +
  '只输出正文本身：不要标题、不要说明、不要 Markdown 围栏。';
let draftEvents;
try {
  draftEvents = await sseChat({ text: draftPrompt, tier: 'writing', workDir });
} catch (err) {
  fail('2/7 起草 POST /v1/chat', err instanceof Error ? err.message : String(err));
}
const draftText = draftEvents
  .filter((e) => e.event === 'text-delta')
  .map((e) => e.data.delta)
  .join('');
const doneCount = draftEvents.filter((e) => e.event === 'done').length;
const errCount = draftEvents.filter((e) => e.event === 'error').length;
if (errCount > 0) fail('2/7 起草 POST /v1/chat', `服务端 error 事件: ${JSON.stringify(draftEvents.find((e) => e.event === 'error').data)}`);
if (doneCount !== 1) fail('2/7 起草 POST /v1/chat', `未收到 done 事件（done=${doneCount}）`);
if (draftText.trim().length < 20) fail('2/7 起草 POST /v1/chat', 'AI 未产出有效正文（text-delta 过短或为空）');
pass('2/7 起草 POST /v1/chat', `text-delta=${draftEvents.filter((e) => e.event === 'text-delta').length}，正文 ${draftText.trim().length} 字，片段="${draftText.trim().slice(0, 60)}…"`);

// ---- 3/7 建暂存候选：AI 产出先进暂存区（人的方向、AI 的笔），不直接落章 ----
const candRes = await fetch(`${baseUrl}/v1/candidates`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    chapter: TEST_CHAPTER,
    original: firstParagraph('manuscript/第一卷·风起/第一章·少年.md'),
    proposed: draftText.trim(),
    instruction: '起草第3章正文（AI 产出先进暂存区）',
  }),
});
if (!candRes.ok) fail('3/7 建暂存候选 POST /v1/candidates', `status=${candRes.status} ${await candRes.text()}`);
const candidate = (await candRes.json()).candidate;
if (!candidate?.id || candidate.status !== 'pending') {
  fail('3/7 建暂存候选 POST /v1/candidates', `候选异常: ${JSON.stringify(candidate)}`);
}
pass('3/7 建暂存候选 POST /v1/candidates', `id=${candidate.id} status=${candidate.status}`);

// ---- 4/7 采纳候选：pending → adopted ----
const patchRes = await fetch(`${baseUrl}/v1/candidates/${candidate.id}`, {
  method: 'PATCH',
  headers: auth,
  body: JSON.stringify({ status: 'adopted' }),
});
const patched = patchRes.ok ? (await patchRes.json()).candidate : null;
if (!patchRes.ok || patched?.status !== 'adopted') {
  fail('4/7 采纳候选 PATCH /v1/candidates/:id', `status=${patchRes.status} body=${JSON.stringify(patched)}`);
}
pass('4/7 采纳候选 PATCH /v1/candidates/:id', `status=${patched.status}`);

// ---- 5/7 落章：把采纳正文写进测试章节（覆盖占位，触发写前自动快照） ----
const chapterContent = `---\ntitle: ${TEST_TITLE}\nstatus: 草稿\n---\n\n${draftText.trim()}\n`;
const wRes = await callTool('write_chapter', { workDir, relPath: TEST_CHAPTER, content: chapterContent });
if (!wRes.ok) fail('5/7 落章 POST /v1/tools/write_chapter', `status=${wRes.status} ${await wRes.text()}`);
const wBody = await wRes.json();
if (wBody?.ok !== true || typeof wBody?.bytes !== 'number' || wBody.bytes <= 0) {
  fail('5/7 落章 POST /v1/tools/write_chapter', `返回异常: ${JSON.stringify(wBody)}`);
}
pass('5/7 落章 POST /v1/tools/write_chapter', `bytes=${wBody.bytes}（覆盖占位已触发写前快照）`);

// ---- 6/7 快照验证：写前自动快照应已存在 ----
const sRes = await callTool('list_snapshots', { workDir, relPath: TEST_CHAPTER });
if (!sRes.ok) fail('6/7 快照验证 POST /v1/tools/list_snapshots', `status=${sRes.status} ${await sRes.text()}`);
const sBody = await sRes.json();
const snapshots = Array.isArray(sBody?.snapshots) ? sBody.snapshots : null;
if (!snapshots || snapshots.length === 0) {
  fail('6/7 快照验证 POST /v1/tools/list_snapshots', '未找到该章写前自动快照');
}
pass('6/7 快照验证 POST /v1/tools/list_snapshots', `快照 ${snapshots.length} 份，最新=${snapshots[0].timestamp}`);

// ---- 7/7 冷读审阅：断言 findings 数组结构 ----
let rvBody = null;
for (let i = 0; i < 5; i++) {
  const rvRes = await fetch(`${baseUrl}/v1/review`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ workDir, chapterRelPath: TEST_CHAPTER }),
  });
  if (rvRes.status === 503 && i < 4) {
    await new Promise((r) => setTimeout(r, 1000)); // MCP 重连中，短退避重试
    continue;
  }
  rvBody = rvRes.ok ? await rvRes.json() : { _status: rvRes.status, _text: (await rvRes.text()).slice(0, 200) };
  break;
}
const findings = rvBody?.findings;
if (!Array.isArray(findings)) {
  fail('7/7 冷读审阅 POST /v1/review', `返回异常: ${JSON.stringify(rvBody)?.slice(0, 300)}`);
}
for (const f of findings) {
  if (typeof f?.severity !== 'string' || typeof f?.quote !== 'string' || typeof f?.why !== 'string') {
    fail('7/7 冷读审阅 POST /v1/review', `findings 元素结构不完整: ${JSON.stringify(f)}`);
  }
}
pass('7/7 冷读审阅 POST /v1/review', `findings ${findings.length} 条${findings.length ? `，首条 severity=${findings[0].severity}` : ''}`);

// ---- 优雅关闭 + 清理临时副本 ----
// Windows 无 SIGTERM：child.kill 走 TerminateProcess，exit code 必为 null（signal='SIGTERM'），属预期。
child.kill('SIGTERM');
const exitCode = await new Promise((resolve) => child.once('exit', (code) => resolve(code)));
if (exitCode !== 0 && !(process.platform === 'win32' && exitCode === null)) {
  fail('core 退出', `core 退出码异常: ${exitCode}`);
}
try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
console.log('[e2e-workflow] 全部通过（7/7，core 已退出，临时 workDir 已清理）');
