// 第 3 周二审脚本 A：core 新端点真实链路实测（真实 LLM）。
// 覆盖：/v1/rewrite SSE 改写、/v1/candidates 建-列-改、/v1/tools 代理、/v1/chat scope 归属 + /v1/sessions?scope 过滤。
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(coreDir, '..');
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'novel-w3a-'));
const workDir = path.join(tmpDir, 'work');
cpSync(path.join(repoRoot, '.demo-work'), workDir, { recursive: true });
const tsxCli = [path.join(coreDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(coreDir, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')].find(existsSync);

const child = spawn(process.execPath, [tsxCli, 'src/main.ts'], {
  cwd: coreDir,
  env: { ...process.env, NOVEL_DIR: path.join(workDir, '.novel'), CORE_RUNTIME_FILE: path.join(tmpDir, 'runtime.json') },
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
const base = `http://127.0.0.1:${info.port}`;
const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${info.token}` };
console.log(`[A] core 就绪 ${base}，workDir=${workDir}`);

const fail = (msg) => { console.error('[A] 失败: ' + msg); child.kill(); process.exit(1); };

// ---- 1. /v1/tools 代理：list_structure ----
const structRes = await fetch(`${base}/v1/tools/list_structure`, {
  method: 'POST', headers: auth,
  body: JSON.stringify({ workDir: workDir.replaceAll('\\', '/') }),
});
if (!structRes.ok) fail('/v1/tools/list_structure ' + structRes.status + ' ' + (await structRes.text()));
const tree = await structRes.json();
const chapter = tree?.[0]?.children?.[0];
if (!chapter?.relPath) fail('结构树为空或缺章: ' + JSON.stringify(tree).slice(0, 200));
console.log(`[A] /v1/tools 代理 OK：${chapter.relPath}，${chapter.wordCount} 字，场=${chapter.scenes?.length}`);

// ---- 2. /v1/rewrite 真实 LLM ----
const original = '清晨的雾气笼罩着青崖山,石阶上的露水还没干。';
const rwRes = await fetch(`${base}/v1/rewrite`, {
  method: 'POST', headers: auth,
  body: JSON.stringify({ original, instruction: '加强画面感，一句话内完成' }),
});
if (!rwRes.ok) fail('/v1/rewrite ' + rwRes.status);
const rwText = await rwRes.text();
const doneMatch = /event: done\ndata: (\{.*\})/.exec(rwText);
if (!doneMatch) fail('/v1/rewrite 无 done: ' + rwText.slice(-300));
const rewritten = JSON.parse(doneMatch[1]).text;
const deltas = (rwText.match(/event: text-delta/g) || []).length;
if (!rewritten || rewritten === original) fail('改写结果为空或与原文相同');
console.log(`[A] /v1/rewrite OK：text-delta=${deltas}，改写="${rewritten.slice(0, 60)}…"`);

// ---- 3. /v1/candidates 建-列-改 ----
const cRes = await fetch(`${base}/v1/candidates`, {
  method: 'POST', headers: auth,
  body: JSON.stringify({ chapter: chapter.relPath, original, proposed: rewritten, instruction: '加强画面感' }),
});
if (!cRes.ok) fail('POST /v1/candidates ' + cRes.status);
const cand = (await cRes.json()).candidate;
const list1 = (await (await fetch(`${base}/v1/candidates?status=pending`, { headers: auth })).json()).candidates;
if (!list1.some((c) => c.id === cand.id)) fail('pending 列表缺新建候选');
const pRes = await fetch(`${base}/v1/candidates/${cand.id}`, {
  method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'adopted' }),
});
if (!pRes.ok || (await pRes.json()).candidate.status !== 'adopted') fail('PATCH adopted 失败');
const list2 = (await (await fetch(`${base}/v1/candidates?status=pending`, { headers: auth })).json()).candidates;
if (list2.some((c) => c.id === cand.id)) fail('adopted 后仍在 pending 列表');
console.log('[A] /v1/candidates 建-列-改 OK（pending→adopted 状态机正确）');

// ---- 4. /v1/chat scope 归属 + /v1/sessions?scope 过滤 ----
async function chat(scope) {
  const res = await fetch(`${base}/v1/chat`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ text: '你觉得这枚铜钱可以埋什么伏笔？一句话。', scope, workDir: workDir.replaceAll('\\', '/') }),
  });
  if (!res.ok) fail('/v1/chat ' + res.status);
  const t = await res.text();
  const m = /event: done\ndata: (\{.*\})/.exec(t);
  if (!m) fail('/v1/chat 无 done');
  return JSON.parse(m[1]).sessionId;
}
await chat(''); // 无归属讨论
await chat(chapter.relPath); // 章节内讨论
const all = (await (await fetch(`${base}/v1/sessions`, { headers: auth })).json()).sessions;
const none = (await (await fetch(`${base}/v1/sessions?scope=`, { headers: auth })).json()).sessions;
const inCh = (await (await fetch(`${base}/v1/sessions?scope=${encodeURIComponent(chapter.relPath)}`, { headers: auth })).json()).sessions;
if (!none.length || !inCh.length) fail(`scope 过滤为空：无归属=${none.length} 章内=${inCh.length}`);
if (none.some((s) => s.scope !== '') || inCh.some((s) => s.scope !== chapter.relPath)) fail('scope 过滤混入错误归属');
console.log(`[A] scope 归属 OK：全部=${all.length}，无归属=${none.length}，章内=${inCh.length}`);

console.log('[A] 全部通过');
child.kill('SIGTERM');
process.exit(0);
