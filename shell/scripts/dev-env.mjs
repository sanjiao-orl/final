// dev-env.mjs —— tauri dev 的环境装配：把 OPENCODE_API_KEY 映射为 core 需要的 LLM_* 变量，再拉起 tauri dev。
// key 不落盘、不进仓；缺 key 时 core 启动即报错（不静默降级）。
import { spawn } from 'node:child_process';

const env = { ...process.env };
env.LLM_BASE_URL ??= 'https://opencode.ai/zen/go/v1';
env.LLM_API_KEY ??= env.OPENCODE_API_KEY ?? '';
env.LLM_MODEL ??= 'kimi-k2.6';
env.LLM_MODEL_CHEAP ??= 'deepseek-v4-flash';

const masked = env.LLM_API_KEY ? `${env.LLM_API_KEY.slice(0, 6)}***` : '(缺失)';
console.log(`[dev-env] LLM_BASE_URL=${env.LLM_BASE_URL} LLM_MODEL=${env.LLM_MODEL} LLM_API_KEY=${masked}`);
if (!env.LLM_API_KEY) console.warn('[dev-env] 警告：未找到 LLM_API_KEY/OPENCODE_API_KEY，core 将无法启动');

const child = spawn('npx', ['tauri', 'dev'], { stdio: 'inherit', env, shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
