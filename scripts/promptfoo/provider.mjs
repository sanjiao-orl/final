// promptfoo 自定义 provider：拉起真实 core（含 domain MCP + 真实 LLM），把 /v1/chat 的完整 SSE
// 消费成 { text, toolCalls, truncated } 供断言。整轮 eval 共用一个 core 与一个 .demo-work 临时副本，
// 测试间会话独立（每次 POST 不带 sessionId，core 各建新会话，互不读对方消息）。
// 环境要求与 e2e-workflow 同口径：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const coreDir = path.join(repoRoot, 'core');

/** 单测聊天调用上限：起草是多步工具链路（MAX_STEPS=8 + 便宜档注入），5 分钟足够宽。 */
const CHAT_TIMEOUT_MS = 300_000;

let state = null;
let shutdownHooked = false;

async function boot() {
  if (!process.env.LLM_API_KEY) {
    throw new Error('未设置 LLM_API_KEY（promptfoo 行为回归需真实 LLM：LLM_BASE_URL/LLM_API_KEY/LLM_MODEL）');
  }
  if (!process.env.LLM_BASE_URL || !process.env.LLM_MODEL) {
    throw new Error('缺少 LLM_BASE_URL 或 LLM_MODEL');
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'novel-promptfoo-'));
  const workDirNative = path.join(tmpDir, 'work');
  cpSync(path.join(repoRoot, '.demo-work'), workDirNative, { recursive: true });
  // 测试 fixture（只进临时副本，不改仓库 .demo-work）：演示书仅一章完整正文（第2章 79 字），
  // 不满足「声口建档」skill 的三章样本门槛——补足第2章正文并预建第3章，让建档用例走完整 happy path。
  seedFixtureChapters(workDirNative);
  const workDir = workDirNative.replaceAll('\\', '/');

  // 与 e2e-workflow 同模式：不经 npx（Windows EINVAL），直接用 node 跑 tsx cli 入口。
  const tsxCli = [
    path.join(coreDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ].find(existsSync);
  if (!tsxCli) throw new Error('找不到 tsx cli 入口（先在仓库根 npm install）');

  const child = spawn(process.execPath, [tsxCli, 'src/main.ts'], {
    cwd: coreDir,
    env: { ...process.env, NOVEL_DIR: path.join(tmpDir, '.novel'), CORE_RUNTIME_FILE: path.join(tmpDir, 'runtime.json') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const { baseUrl, token } = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('core 60s 内未就绪')), 60_000);
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const line = buf.split('\n').find((l) => l.includes('"event":"ready"'));
      if (line) {
        clearTimeout(timer);
        try {
          const info = JSON.parse(line);
          resolve({ baseUrl: `http://127.0.0.1:${info.port}`, token: info.token });
        } catch (err) {
          reject(err);
        }
      }
    });
    child.once('exit', (code) => reject(new Error(`core 提前退出，code=${code}`)));
  });

  if (!shutdownHooked) {
    for (const sig of ['SIGINT', 'SIGTERM', 'exit']) process.on(sig, shutdown);
    shutdownHooked = true;
  }
  state = { child, tmpDir, workDir, baseUrl, token };
  return state;
}

function shutdown() {
  if (!state) return;
  try { state.child.kill('SIGTERM'); } catch { /* 已退出 */ }
  try { rmSync(state.tmpDir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  state = null;
}

/** 建档样本 fixture：第2章补正文段、预建第3章（口径与第一章的林渡/铜钱线一致）。 */
function seedFixtureChapters(workDirNative) {
  const vol = path.join(workDirNative, 'manuscript', '第一卷·风起');
  const ch2 = path.join(vol, '第2章·山道.md');
  try {
    appendFileSync(ch2, '\n\n日头爬到头顶时，林渡在道旁歇脚。货郎告诉他，山下的集子上最近有人专收旧铜钱，给价是市价的三倍。他捏着怀里那枚沉甸甸的铜钱，没有接话。\n\n「小兄弟，你那枚要是出手，我引荐。」货郎压低声音。\n\n「不卖。」林渡起身，继续往西走。催行的日头把影子压得很短，他没有回头。\n', 'utf8');
  } catch { /* 演示书结构变了就跳过（fixture 失败由断言暴露） */ }
  try {
    writeFileSync(path.join(vol, '第3章·客栈.md'), '---\ntitle: 第3章·客栈\nstatus: 草稿\npov: 林渡\n---\n\n入夜前，林渡到了镇子。客栈的伙计多看了他两眼——一个背着包袱的少年，独自走了三天的山路。\n\n他要了一间最便宜的房，把铜钱压在枕头底下。半夜里，他听见隔壁有人低声争执，提到「青崖山」三个字。\n\n林渡睁开眼，没有动。窗纸上映着晃动的人影，过了一阵，脚步声往楼下去了。\n\n他摸了摸枕下的铜钱，比白天又沉了些。\n', 'utf8');
  } catch { /* 同上 */ }
}

/** 完整消费 SSE 流，返回事件数组 [{ event, data }]（与 e2e-workflow 同一套解析）。 */
async function consumeSse(res) {
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

export class NovelCoreChatProvider {
  /** promptfoo 0.122 的 file provider 约定：默认导出构造器，接口 = id()/toString()/callApi(prompt, context)。 */
  constructor(options) {
    this.options = options ?? {};
  }

  id() {
    return 'novel-core-chat';
  }

  toString() {
    return '[novel core /v1/chat provider]';
  }

  async callApi(prompt, context) {
    const s = state ?? (await boot());
    const body = { text: prompt, workDir: s.workDir };
    if (context?.vars?.tier) body.tier = String(context.vars.tier);
    if (context?.vars?.mode) body.mode = String(context.vars.mode);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    let events;
    try {
      const res = await fetch(`${s.baseUrl}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`/v1/chat 返回 ${res.status}: ${await res.text()}`);
      events = await consumeSse(res);
    } catch (err) {
      return { error: `chat 请求失败: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      clearTimeout(timer);
    }

    const errEv = events.find((e) => e.event === 'error');
    if (errEv) return { error: `core 流错误: ${JSON.stringify(errEv.data)}` };
    const doneEv = [...events].reverse().find((e) => e.event === 'done');
    if (!doneEv) return { error: '未见 done 事件（SSE 断流）' };

    const text = events.filter((e) => e.event === 'text-delta').map((e) => e.data.delta).join('');
    const toolCalls = events
      .filter((e) => e.event === 'tool-call')
      .map((e) => ({ name: e.data.name, args: e.data.args ?? {} }));
    return { output: JSON.stringify({ text, toolCalls, truncated: doneEv.data?.truncated === true }) };
  }
}

export default NovelCoreChatProvider;
