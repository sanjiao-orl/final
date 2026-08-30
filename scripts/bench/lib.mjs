// scripts/bench/lib.mjs —— 试车台共享库：语料读取 / LLM 客户端（默认免费档）/ 结构化生成带重试与用量累计。
import fs from 'node:fs';
import path from 'node:path';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateObject, generateText } from 'ai';

/** 读语料章：manuscriptRoot=<workDir>/manuscript，按 fm order 排序；relPath 用正斜杠（产品口径）。 */
export function readChapters(manuscriptRoot) {
  const out = [];
  for (const vol of fs.readdirSync(manuscriptRoot)) {
    const vdir = path.join(manuscriptRoot, vol);
    if (!fs.statSync(vdir).isDirectory()) continue;
    for (const f of fs.readdirSync(vdir)) {
      if (!f.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(vdir, f), 'utf8');
      const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      const fm = fmMatch ? fmMatch[1] : '';
      const order = Number(fm.match(/^order:\s*(\d+)/m)?.[1] ?? 0);
      const title = fm.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? f.replace(/\.md$/, '');
      const body = (fmMatch ? raw.slice(fmMatch[0].length) : raw).trim();
      out.push({ order, title, volume: vol, relPath: `manuscript/${vol}/${f}`, body });
    }
  }
  return out.sort((a, b) => a.order - b.order);
}

/** bench LLM 客户端：openai-compatible；structured 默认 false（免费档上游常不支持 json_schema，
 *  走提示词 JSON + 容错解析；core 产品路径的 supportsStructuredOutputs:true 是其已验供应商口径，不搬）。 */
export function makeModel(modelId) {
  const baseURL = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = modelId ?? process.env.LLM_MODEL_CHEAP ?? process.env.LLM_MODEL;
  if (!baseURL || !apiKey || !model) {
    throw new Error('缺少 LLM 环境变量：需要 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL_CHEAP（或 LLM_MODEL）');
  }
  const provider = createOpenAICompatible({ name: 'bench', baseURL, apiKey, supportsStructuredOutputs: false });
  return { model: provider.languageModel(model), modelId: model };
}

/** 全局用量累计（token）；脚本结束时打印，喂块 3 提前触发器读数。 */
export const usage = { input: 0, output: 0, calls: 0 };
export function printUsage(label) {
  console.error(`[用量] ${label}: calls=${usage.calls} input=${usage.input} output=${usage.output} tokens`);
}

/** 结构化生成：提示词声明 JSON 结构 + 容错解析（首个 { 到末个 }）+ validate 校验/归一 + 指数退避重试。 */
export async function genJSON({ model, shape, validate, system, prompt, maxRetries = 3, temperature = 0.2 }) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    try {
      const res = await generateText({
        model,
        system: (system ?? '') + '\n只输出一个 JSON 对象：不要解释、不要 Markdown 围栏。结构：' + shape,
        prompt,
        temperature,
      });
      usage.calls++;
      usage.input += res.usage?.inputTokens ?? 0;
      usage.output += res.usage?.outputTokens ?? 0;
      const text = res.text ?? '';
      const s = text.indexOf('{');
      const e = text.lastIndexOf('}');
      if (s < 0 || e <= s) throw new Error(`响应无 JSON：${text.slice(0, 120)}`);
      const obj = JSON.parse(text.slice(s, e + 1));
      return validate ? validate(obj) : obj;
    } catch (err) {
      lastErr = err;
      console.error(`[genJSON 重试 ${attempt + 1}/${maxRetries}] ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }
  throw lastErr;
}
