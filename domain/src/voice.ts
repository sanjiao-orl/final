// voice.ts —— 声口指纹确定性度量（块2·③）：句长分布/对白占比/段长/高频二字组，纯计算不涉 LLM。
// 分层纪律（现状.md 块2）：指纹只描述「是什么样」，不评好坏；compare 产出的偏离提示作仪表不入门禁；
// 阈值写死在本文件，可调化归「确定性治理可调化」全局缓做项，不单独开口子。
// 消费方：模型/作者经 voice_fingerprint 工具取全书或逐章底数；core 续写/改写管道用 texts+compare 做产出对照（块2·④）。
import { listStructure, readChapter } from './tools.js';

/** CJK 判定，与 qualityScan.countCjk 同域（含扩展 A 区）。 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

function isCjk(ch: string): boolean {
  return CJK_RE.test(ch);
}

function cjkOf(text: string): number {
  let n = 0;
  for (const ch of text) if (isCjk(ch)) n++;
  return n;
}

export interface VoiceMetrics {
  /** 样本键：relPath（文件样本）或 text:N（内联样本）。 */
  key: string;
  /** 总 CJK 字数（分母口径）。 */
  cjkChars: number;
  sentenceCount: number;
  /** 每句 CJK 字数均值（1 位小数）。 */
  sentenceLenMean: number;
  /** 句长中位数。 */
  sentenceLenP50: number;
  /** 短句占比（≤12 CJK）。 */
  shortSentenceRatio: number;
  /** 长句占比（≥50 CJK）。 */
  longSentenceRatio: number;
  /** 对白占比：成对引号（「」『』“”）内 CJK / 总 CJK；引号跨行不配对（防一未闭合吞掉后半篇）。 */
  dialogueRatio: number;
  paragraphCount: number;
  /** 每段 CJK 均值（1 位小数）。 */
  paragraphLenMean: number;
  /** 高频相邻二字组 top8（出现 ≥2 次；惯用词的确定性代理）。 */
  topGrams: Array<{ gram: string; n: number }>;
}

/** 句界：。！？!?…（… 连续多个算一个界）。 */
const SENTENCE_SPLIT_RE = /[。！？!?…]+/;
const SHORT_SENTENCE_CJK = 12;
const LONG_SENTENCE_CJK = 50;

/** 对白引号对：开引号与对应闭引号同下标。 */
const QUOTE_PAIRS: Array<[string, string]> = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
];

function dialogueCjk(text: string): number {
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    let openPair: [string, string] | null = null;
    for (const ch of line) {
      if (!openPair) {
        openPair = QUOTE_PAIRS.find(([o]) => o === ch) ?? null;
      } else if (ch === openPair[1]) {
        openPair = null;
      } else if (isCjk(ch)) {
        total++;
      }
    }
  }
  return total;
}

function topGrams(text: string, limit = 8): Array<{ gram: string; n: number }> {
  const counts = new Map<string, number>();
  let run = '';
  const flush = () => {
    for (let i = 0; i + 1 < run.length; i++) {
      const g = run.slice(i, i + 2);
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    run = '';
  };
  for (const ch of text) {
    if (isCjk(ch)) run += ch;
    else flush();
  }
  flush();
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([gram, n]) => ({ gram, n }));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 计算一段正文的声口指纹（正文应为剥掉 frontmatter 后的 body；内联文本直接给原文）。 */
export function voiceMetrics(key: string, body: string): VoiceMetrics {
  const sentences = body
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => cjkOf(s) > 0)
    .map((s) => cjkOf(s))
    .sort((a, b) => a - b);
  const sentenceCount = sentences.length;
  const totalSent = sentences.reduce((a, b) => a + b, 0);
  const paragraphs = body
    .split(/\r?\n+/)
    .map((p) => p.trim())
    .filter((p) => cjkOf(p) > 0);
  const cjkChars = cjkOf(body);
  return {
    key,
    cjkChars,
    sentenceCount,
    sentenceLenMean: sentenceCount ? round1(totalSent / sentenceCount) : 0,
    sentenceLenP50: sentenceCount ? sentences[Math.floor(sentenceCount / 2)]! : 0,
    shortSentenceRatio: sentenceCount ? round1(sentences.filter((n) => n <= SHORT_SENTENCE_CJK).length / sentenceCount) : 0,
    longSentenceRatio: sentenceCount ? round1(sentences.filter((n) => n >= LONG_SENTENCE_CJK).length / sentenceCount) : 0,
    dialogueRatio: cjkChars ? round2(dialogueCjk(body) / cjkChars) : 0,
    paragraphCount: paragraphs.length,
    paragraphLenMean: paragraphs.length ? round1(paragraphs.reduce((a, p) => a + cjkOf(p), 0) / paragraphs.length) : 0,
    topGrams: topGrams(body),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** —— 偏离对照（块2·④）—— 阈值写死；样本 CJK 不足 100 字不出任何提示（信号量不够，宁缺勿噪）。 */
const DEVIATION_MIN_CJK = 100;
const DIALOGUE_RATIO_DELTA = 0.1;
const SENTENCE_MEAN_REL_DELTA = 0.3;
const SHORT_RATIO_DELTA = 0.15;
const LONG_RATIO_DELTA = 0.15;

export interface VoiceDeviation {
  /** 各指标基线→产出值（给 UI 做 title 明细）。 */
  deltas: {
    dialogueRatio: { base: number; out: number };
    sentenceLenMean: { base: number; out: number };
    shortSentenceRatio: { base: number; out: number };
    longSentenceRatio: { base: number; out: number };
    gramOverlap: { base: number; out: number };
  };
  /** 人读偏离提示（中文一行一条；空数组 = 无显著偏离或样本不足）。 */
  flags: string[];
}

/** 对照两份指纹产出偏离提示；flags 只作仪表，调用方不得据此拦内容。 */
export function compareVoice(base: VoiceMetrics, out: VoiceMetrics): VoiceDeviation {
  const deltas = {
    dialogueRatio: { base: base.dialogueRatio, out: out.dialogueRatio },
    sentenceLenMean: { base: base.sentenceLenMean, out: out.sentenceLenMean },
    shortSentenceRatio: { base: base.shortSentenceRatio, out: out.shortSentenceRatio },
    longSentenceRatio: { base: base.longSentenceRatio, out: out.longSentenceRatio },
    gramOverlap: { base: base.topGrams.length, out: out.topGrams.length },
  };
  const flags: string[] = [];
  if (base.cjkChars < DEVIATION_MIN_CJK || out.cjkChars < DEVIATION_MIN_CJK) {
    return { deltas, flags };
  }
  if (Math.abs(out.dialogueRatio - base.dialogueRatio) >= DIALOGUE_RATIO_DELTA) {
    flags.push(`对白占比 ${pct(base.dialogueRatio)} → ${pct(out.dialogueRatio)}`);
  }
  if (base.sentenceLenMean > 0 && Math.abs(out.sentenceLenMean - base.sentenceLenMean) / base.sentenceLenMean >= SENTENCE_MEAN_REL_DELTA) {
    flags.push(`平均句长 ${base.sentenceLenMean} → ${out.sentenceLenMean} 字`);
  }
  if (Math.abs(out.shortSentenceRatio - base.shortSentenceRatio) >= SHORT_RATIO_DELTA) {
    flags.push(`短句占比 ${pct(base.shortSentenceRatio)} → ${pct(out.shortSentenceRatio)}`);
  }
  if (Math.abs(out.longSentenceRatio - base.longSentenceRatio) >= LONG_RATIO_DELTA) {
    flags.push(`长句占比 ${pct(base.longSentenceRatio)} → ${pct(out.longSentenceRatio)}`);
  }
  const baseGrams = new Set(base.topGrams.map((g) => g.gram));
  const overlap = out.topGrams.filter((g) => baseGrams.has(g.gram)).length;
  if (base.topGrams.length >= 6 && out.topGrams.length >= 6 && overlap === 0) {
    flags.push('惯用二字组零重合（基线与产出 top8 无交集）');
  }
  return { deltas, flags };
}

export interface VoiceFingerprintInput {
  workDir?: string | undefined;
  relPaths?: string[] | undefined;
  texts?: string[] | undefined;
  compare?: { baselineIndex: number; sampleIndex: number } | undefined;
}

export interface VoiceFingerprintResult {
  samples: VoiceMetrics[];
  deviation?: VoiceDeviation;
}

/**
 * voice_fingerprint 工具实现：
 * - relPaths（缺省=全书章，需 workDir）逐文件取样（read_chapter 同口径剥 frontmatter 取 body）；
 * - texts（≤4 段内联文本，无需 workDir）供续写/改写产出对照；
 * - compare 按 samples 下标（relPaths 样本在前、texts 在后）产出偏离提示。
 */
export function voiceFingerprint(input: VoiceFingerprintInput): VoiceFingerprintResult {
  // 取样三态：显式 relPaths / 仅 texts（内联对照）/ 全书（缺省，需 workDir）
  const hasTexts = (input.texts?.length ?? 0) > 0;
  let effectiveRelPaths: string[];
  if (input.relPaths) {
    if (!input.workDir) throw new Error('voice_fingerprint 用 relPaths 时必须给 workDir');
    effectiveRelPaths = input.relPaths;
  } else if (!hasTexts) {
    if (!input.workDir) throw new Error('voice_fingerprint 无样本：给 relPaths/texts 之一，或带 workDir 走全书模式');
    effectiveRelPaths = allChapterRelPaths(input.workDir);
    if (!effectiveRelPaths.length) throw new Error('voice_fingerprint 全书模式未找到任何章（manuscript 为空）');
  } else {
    effectiveRelPaths = [];
  }
  const samples: VoiceMetrics[] = [];
  for (const relPath of effectiveRelPaths) {
    samples.push(voiceMetrics(relPath, readChapter(input.workDir!, relPath).body ?? ''));
  }
  (input.texts ?? []).forEach((text, i) => {
    samples.push(voiceMetrics(`text:${i}`, text));
  });
  const result: VoiceFingerprintResult = { samples };
  if (input.compare) {
    const { baselineIndex, sampleIndex } = input.compare;
    const base = samples[baselineIndex];
    const out = samples[sampleIndex];
    if (!base || !out) {
      throw new Error(`voice_fingerprint compare 下标越界: baseline=${baselineIndex}, sample=${sampleIndex}（samples 共 ${samples.length} 份）`);
    }
    result.deviation = compareVoice(base, out);
  }
  return result;
}

/** 全书章相对路径清单（listStructure 拍平，卷序即章序）。 */
function allChapterRelPaths(workDir: string): string[] {
  return listStructure(workDir).flatMap((v) => v.children.map((c) => c.relPath));
}
