// e2e-workflow：真实写作闭环 e2e（真实 LLM，不进单测）。LLM_API_KEY 在场则起 core 服务跑一遍
// 「握手 → 碰撞 → 留痕闸门 → 起草 → 暂存候选 → 采纳 → 落章 → 章摘要 → 发布前质检 → 快照 → 冷读审阅」闭环并逐环节校验；不在场打印跳过。
// 批一③（0013）扩步序：碰撞 → blueprint=locked → 起草，闸门进自动化验证。
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

/** POST /v1/continue 并完整消费 SSE。 */
async function sseContinue(body) {
  const res = await fetch(`${baseUrl}/v1/continue`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`/v1/continue 返回 ${res.status}: ${await res.text()}`);
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
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let event = 'message'; const dataLines = [];
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

/** POST /v1/tools/:name 代理；MCP 重连中回 503，短退避重试（core 刚就绪时可能还没连上）。 */
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

// ---- 1/12 握手：断言 version / protocol ----
const healthRes = await fetch(`${baseUrl}/v1/health`, { headers: auth });
const health = healthRes.ok ? await healthRes.json() : null;
if (
  !healthRes.ok || health?.ok !== true ||
  typeof health?.version !== 'string' || health.version === '' ||
  typeof health?.protocol !== 'number' || health.protocol < 1
) {
  fail('1/12 握手 /v1/health', `status=${healthRes.status} body=${JSON.stringify(health)}`);
}
const llmRes = await fetch(`${baseUrl}/v1/llm`, { headers: auth });
const llm = llmRes.ok ? await llmRes.json() : null;
if (llmRes.status !== 200 || typeof llm?.effective?.writing?.model !== 'string' || llm.effective.writing.model === '') {
  fail('1/12 握手 /v1/llm', `status=${llmRes.status} body=${JSON.stringify(llm)}`);
}
pass('1/12 握手 /v1/llm', `生效模型=${llm.effective.writing.model}`);

// ---- 2/12 碰撞：mode=collide 真实碰撞对话，断言四节固定标题齐备（0013：碰撞 → blueprint=locked → 起草） ----
let collideEvents;
try {
  collideEvents = await sseChat({
    text: `我在构思《${TEST_TITLE}》：林渡夜宿客栈，雾夜听到窗外有人低声提及「青崖山」。请对这个构思做标准碰撞。`,
    workDir,
    chapter: TEST_CHAPTER,
    mode: 'collide',
  });
} catch (err) {
  fail('2/12 碰撞 POST /v1/chat', err instanceof Error ? err.message : String(err));
}
const collideText = collideEvents
  .filter((e) => e.event === 'text-delta')
  .map((e) => e.data.delta)
  .join('');
const collideDone = collideEvents.filter((e) => e.event === 'done').length;
const collideErr = collideEvents.filter((e) => e.event === 'error').length;
if (collideErr > 0) fail('2/12 碰撞 POST /v1/chat', `服务端 error 事件: ${JSON.stringify(collideEvents.find((e) => e.event === 'error').data)}`);
if (collideDone !== 1) fail('2/12 碰撞 POST /v1/chat', `未收到 done 事件（done=${collideDone}）`);
// 四节固定标题是壳对比色渲染的契约（collide-parse 判据），缺任一即协议未被遵循
for (const h of ['## 方案', '## 漏洞', '## 反方', '## 裁决']) {
  if (!collideText.includes(h)) {
    fail('2/12 碰撞 POST /v1/chat', `输出缺固定标题「${h}」（碰撞协议未被遵循），输出开头=${collideText.slice(0, 120)}`);
  }
}
pass('2/12 碰撞 POST /v1/chat', `四节标题齐备，输出 ${collideText.trim().length} 字`);

// ---- 3/12 留痕与闸门：decision_append 登记 → chapter_set_blueprint 置 locked → 读回核对（0013 决策 1/2） ----
const dRes = await callTool('decision_append', {
  workDir,
  topic: `${TEST_TITLE} 构思碰撞`,
  stance: '雾夜听闻「青崖山」方向成立',
  ruling: '采纳',
  reason: 'e2e 碰撞闸门自动化验证',
  chapters: [TEST_CHAPTER],
});
if (!dRes.ok) fail('3/12 留痕 POST /v1/tools/decision_append', `status=${dRes.status} ${await dRes.text()}`);
const dBody = await dRes.json();
// 编号不断言 D-001：碰撞步的模型可能已按协议义务自调 decision_append 先登记过（e2e 实跑观测到过），只断言格式
if (dBody?.appended !== 1 || !/^D-\d{3}$/.test(dBody?.id ?? '')) {
  fail('3/12 留痕 POST /v1/tools/decision_append', `返回异常: ${JSON.stringify(dBody)}`);
}
const bRes = await callTool('chapter_set_blueprint', { workDir, relPath: TEST_CHAPTER, value: 'locked' });
if (!bRes.ok) fail('3/12 闸门 POST /v1/tools/chapter_set_blueprint', `status=${bRes.status} ${await bRes.text()}`);
// 读回 frontmatter 核对 blueprint 落盘
const rcRes = await callTool('read_chapter', { workDir, relPath: TEST_CHAPTER });
const rcBody = rcRes.ok ? await rcRes.json() : null;
if (rcBody?.frontmatter?.blueprint !== 'locked') {
  fail('3/12 闸门读回 POST /v1/tools/read_chapter', `blueprint 应为 locked: ${JSON.stringify(rcBody?.frontmatter)}`);
}
// 讨论沉淀读取：decision_tail 应含刚登记的条目（模型在碰撞步可能已先登记过，按本条 id 查）
const dtRes = await callTool('decision_tail', { workDir, chapter: TEST_CHAPTER });
const dtBody = dtRes.ok ? await dtRes.json() : null;
if (
  typeof dtBody?.total !== 'number' || dtBody.total < 1 ||
  !Array.isArray(dtBody?.lines) || !dtBody.lines.some((l) => String(l).includes(dBody.id))
) {
  fail('3/12 沉淀读取 POST /v1/tools/decision_tail', `返回异常: ${JSON.stringify(dtBody)}`);
}
pass('3/12 留痕与闸门', `decision ${dBody.id} 已登记，blueprint=locked 读回一致，decision_tail total=${dtBody.total}`);

// ---- 4/12 起草：真实 LLM 按「人的方向」起草一小段章节正文 ----
const draftPrompt =
  '按「人的方向，你的笔」起草一小段章节正文：\n' +
  '方向：延续第一章《少年》的悬念——林渡夜宿客栈时听到窗外有人低声提及「青崖山」。\n' +
  '请为测试章节《第3章·雾夜》起草一段约 150~250 字的正文场景（第三人称限知、感官细节密、网文向），紧接夜宿之后。\n' +
  '只输出正文本身：不要标题、不要说明、不要 Markdown 围栏。';
let draftEvents;
try {
  draftEvents = await sseChat({ text: draftPrompt, tier: 'writing', workDir });
} catch (err) {
  fail('4/12 起草 POST /v1/chat', err instanceof Error ? err.message : String(err));
}
const draftText = draftEvents
  .filter((e) => e.event === 'text-delta')
  .map((e) => e.data.delta)
  .join('');
const doneCount = draftEvents.filter((e) => e.event === 'done').length;
const errCount = draftEvents.filter((e) => e.event === 'error').length;
if (errCount > 0) fail('4/12 起草 POST /v1/chat', `服务端 error 事件: ${JSON.stringify(draftEvents.find((e) => e.event === 'error').data)}`);
if (doneCount !== 1) fail('4/12 起草 POST /v1/chat', `未收到 done 事件（done=${doneCount}）`);
if (draftText.trim().length < 20) fail('4/12 起草 POST /v1/chat', 'AI 未产出有效正文（text-delta 过短或为空）');
pass('4/12 起草 POST /v1/chat', `text-delta=${draftEvents.filter((e) => e.event === 'text-delta').length}，正文 ${draftText.trim().length} 字，片段="${draftText.trim().slice(0, 60)}…"`);

// ---- 5/12 续写：便宜档触发式续写，完整消费 SSE 并核对 done ----
const continueEvents = await sseContinue({ context: '林渡推开客栈的窗，雾气沿着窗棂无声漫进来，远处忽然传来一声铃响。' });
const continueErrors = continueEvents.filter((e) => e.event === 'error');
const continueDones = continueEvents.filter((e) => e.event === 'done');
if (continueErrors.length || continueDones.length !== 1 || String(continueDones[0]?.data?.text ?? '').length < 20) {
  fail('5/12 续写 POST /v1/continue', `SSE 异常: ${JSON.stringify(continueEvents)}`);
}
pass('5/12 续写 POST /v1/continue', `done=1，正文 ${String(continueDones[0].data.text).length} 字`);

// ---- 6/12 建暂存候选：AI 产出先进暂存区（人的方向、AI 的笔），不直接落章 ----
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
if (!candRes.ok) fail('6/12 建暂存候选 POST /v1/candidates', `status=${candRes.status} ${await candRes.text()}`);
const candidate = (await candRes.json()).candidate;
if (!candidate?.id || candidate.status !== 'pending') {
  fail('6/12 建暂存候选 POST /v1/candidates', `候选异常: ${JSON.stringify(candidate)}`);
}
pass('6/12 建暂存候选 POST /v1/candidates', `id=${candidate.id} status=${candidate.status}`);

// ---- 7/12 采纳候选：pending → adopted ----
const patchRes = await fetch(`${baseUrl}/v1/candidates/${candidate.id}`, {
  method: 'PATCH',
  headers: auth,
  body: JSON.stringify({ status: 'adopted' }),
});
const patched = patchRes.ok ? (await patchRes.json()).candidate : null;
if (!patchRes.ok || patched?.status !== 'adopted') {
  fail('7/12 采纳候选 PATCH /v1/candidates/:id', `status=${patchRes.status} body=${JSON.stringify(patched)}`);
}
pass('7/12 采纳候选 PATCH /v1/candidates/:id', `status=${patched.status}`);

// ---- 8/12 落章：把采纳正文写进测试章节（覆盖占位，触发写前自动快照）；fm 保留 blueprint: locked——碰撞放行后才起草，落章不丢闸门状态位 ----
const chapterContent = `---\ntitle: ${TEST_TITLE}\nstatus: 草稿\nblueprint: locked\n---\n\n${draftText.trim()}\n`;
const wRes = await callTool('write_chapter', { workDir, relPath: TEST_CHAPTER, content: chapterContent });
if (!wRes.ok) fail('8/12 落章 POST /v1/tools/write_chapter', `status=${wRes.status} ${await wRes.text()}`);
const wBody = await wRes.json();
if (wBody?.ok !== true || typeof wBody?.bytes !== 'number' || wBody.bytes <= 0) {
  fail('8/12 落章 POST /v1/tools/write_chapter', `返回异常: ${JSON.stringify(wBody)}`);
}
pass('8/12 落章 POST /v1/tools/write_chapter', `bytes=${wBody.bytes}（覆盖占位已触发写前快照）`);

// 落章后核对 list_structure 透出 blueprint（壳结构树徽标的数据源）
const lsRes = await callTool('list_structure', { workDir });
const lsText = lsRes.ok ? JSON.stringify(await lsRes.json()) : '';
if (!lsRes.ok || !lsText.includes('"blueprint":"locked"')) {
  fail('8/12 落章 POST /v1/tools/list_structure', `blueprint 未透出到结构树: ${lsText.slice(0, 200)}`);
}
pass('8/12 落章 list_structure 透出', 'blueprint=locked 已透出');

// ---- 9/12 章摘要生成：POST /v1/summary/generate → 断言 record，并经工具代理回读缓存落盘 ----
let sumBody = null;
for (let i = 0; i < 5; i++) {
  const sumRes = await fetch(`${baseUrl}/v1/summary/generate`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ workDir, relPath: TEST_CHAPTER }),
  });
  if (sumRes.status === 502 && i < 4) {
    await new Promise((r) => setTimeout(r, 1000)); // MCP 刚就绪可能尚未连上 domain 工具，短退避重试
    continue;
  }
  sumBody = sumRes.ok ? await sumRes.json() : { _status: sumRes.status, _text: (await sumRes.text()).slice(0, 200) };
  break;
}
if (sumBody?.ok !== true || typeof sumBody?.record?.summary !== 'string' || !sumBody.record.summary.trim()) {
  fail('9/12 章摘要生成 POST /v1/summary/generate', `返回异常: ${JSON.stringify(sumBody)?.slice(0, 300)}`);
}
if (!Number.isInteger(sumBody.record.tension) || sumBody.record.tension < 1 || sumBody.record.tension > 10) {
  fail('9/12 章摘要生成 POST /v1/summary/generate', `tension 越界: ${JSON.stringify(sumBody.record)}`);
}
// 经工具代理回读导生缓存：断言摘要确实落盘
const rsRes = await callTool('read_chapter_summaries', { workDir, relPath: TEST_CHAPTER });
const rsBody = rsRes.ok ? await rsRes.json() : null;
const cached = Array.isArray(rsBody?.summaries) ? rsBody.summaries.find((s) => s.relPath === TEST_CHAPTER) : null;
if (!cached || typeof cached.summary !== 'string' || !cached.summary.trim()) {
  fail('9/12 章摘要缓存读回 POST /v1/tools/read_chapter_summaries', `返回异常: ${JSON.stringify(rsBody)?.slice(0, 300)}`);
}
pass('9/12 章摘要生成 POST /v1/summary/generate', `tension=${sumBody.record.tension} sceneType=${sumBody.record.sceneType} 字数=${sumBody.record.wordCount}，摘要 ${sumBody.record.summary.length} 字（缓存读回一致）`);

// ---- 10/12 发布前质检：POST /v1/quality/check → 断言 findings 是数组（LLM 输出不确定，不断言具体内容） ----
let qcBody = null;
for (let i = 0; i < 5; i++) {
  const qcRes = await fetch(`${baseUrl}/v1/quality/check`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ workDir, relPath: TEST_CHAPTER }),
  });
  if (qcRes.status === 502 && i < 4) {
    await new Promise((r) => setTimeout(r, 1000)); // MCP 重连窗口短退避
    continue;
  }
  qcBody = qcRes.ok ? await qcRes.json() : { _status: qcRes.status, _text: (await qcRes.text()).slice(0, 200) };
  break;
}
if (qcBody?.ok !== true || !Array.isArray(qcBody?.findings)) {
  fail('10/12 发布前质检 POST /v1/quality/check', `返回异常: ${JSON.stringify(qcBody)?.slice(0, 300)}`);
}
pass('10/12 发布前质检 POST /v1/quality/check', `findings ${qcBody.findings.length} 条${qcBody.truncated ? '（正文已截断）' : ''}`);

// ---- 11/12 快照验证：写前自动快照应已存在 ----
const sRes = await callTool('list_snapshots', { workDir, relPath: TEST_CHAPTER });
if (!sRes.ok) fail('11/12 快照验证 POST /v1/tools/list_snapshots', `status=${sRes.status} ${await sRes.text()}`);
const sBody = await sRes.json();
const snapshots = Array.isArray(sBody?.snapshots) ? sBody.snapshots : null;
if (!snapshots || snapshots.length === 0) {
  fail('11/12 快照验证 POST /v1/tools/list_snapshots', '未找到该章写前自动快照');
}
pass('11/12 快照验证 POST /v1/tools/list_snapshots', `快照 ${snapshots.length} 份，最新=${snapshots[0].timestamp}`);

// ---- 12/12 冷读审阅：断言 findings 数组结构 ----
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
  fail('12/12 冷读审阅 POST /v1/review', `返回异常: ${JSON.stringify(rvBody)?.slice(0, 300)}`);
}
for (const f of findings) {
  if (typeof f?.severity !== 'string' || typeof f?.quote !== 'string' || typeof f?.why !== 'string') {
    fail('12/12 冷读审阅 POST /v1/review', `findings 元素结构不完整: ${JSON.stringify(f)}`);
  }
}
pass('12/12 冷读审阅 POST /v1/review', `findings ${findings.length} 条${findings.length ? `，首条 severity=${findings[0].severity}` : ''}`);

// ---- 优雅关闭 + 清理临时副本 ----
// Windows 无 SIGTERM：child.kill 走 TerminateProcess，exit code 必为 null（signal='SIGTERM'），属预期。
child.kill('SIGTERM');
const exitCode = await new Promise((resolve) => child.once('exit', (code) => resolve(code)));
if (exitCode !== 0 && !(process.platform === 'win32' && exitCode === null)) {
  fail('core 退出', `core 退出码异常: ${exitCode}`);
}
try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
console.log('[e2e-workflow] 全部通过（12/12，core 已退出，临时 workDir 已清理）');
