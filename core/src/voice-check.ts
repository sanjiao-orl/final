// voice-check.ts —— 续写/改写产出的声口偏离对照（块2·④）：调 domain voice_fingerprint（texts+compare），
// 把偏离提示附到 SSE done 事件。仪表非门禁：工具缺失/超时/报错一律降级为不带 voice 字段，绝不拦产出。
// 分层纪律：度量与阈值的事实源在 domain（voice.ts），core 只搬运；阈值可调化归全局缓做项。
import type { ToolSet } from 'ai';
import { callDomainTool, unwrapToolPayload } from './tool-call.js';

/** done 事件附带的声口偏离视图（domain deviation 的契约镜像，只透传）。 */
export interface VoiceDeviationView {
  deltas: {
    dialogueRatio: { base: number; out: number };
    sentenceLenMean: { base: number; out: number };
    shortSentenceRatio: { base: number; out: number };
    longSentenceRatio: { base: number; out: number };
    gramOverlap: { base: number; out: number };
  };
  flags: string[];
}

/** 偏离计算自身的兜底上限：正常毫秒级（本地 stdio 纯计算），8s 防挂起拖慢 done。 */
const VOICE_CHECK_TIMEOUT_MS = 8_000;

export async function voiceDeviationFor(
  tools: ToolSet | undefined,
  toolsAvailable: (() => boolean) | undefined,
  baselineText: string,
  outputText: string
): Promise<VoiceDeviationView | undefined> {
  if (!tools?.voice_fingerprint || (toolsAvailable && !toolsAvailable())) return undefined;
  try {
    const raw = await Promise.race([
      callDomainTool(
        tools,
        'voice_fingerprint',
        {
          texts: [baselineText.slice(0, 20_000), outputText.slice(0, 20_000)],
          compare: { baselineIndex: 0, sampleIndex: 1 },
        },
        { toolCallId: 'voice-deviation' }
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('voice_fingerprint 超时')), VOICE_CHECK_TIMEOUT_MS);
      }),
    ]);
    const payload = unwrapToolPayload(raw) as { deviation?: VoiceDeviationView } | undefined;
    return payload?.deviation ?? undefined;
  } catch (err) {
    console.warn(`[voice] 声口偏离计算降级（done 不带 voice）: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
