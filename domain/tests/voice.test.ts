/**
 * voice.test.ts —— 声口指纹确定性度量（块2·③）：指标计算口径、偏离对照阈值与门控、取样三态。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVoice, voiceFingerprint, voiceMetrics } from '../src/voice.js';
import { makeWorkDir, writeTree } from './helpers.js';

const LONG = '雾'.repeat(60) + '。'; // 60 CJK 长句
const SHORT = '他走了。'; // 3 CJK 短句

describe('voiceMetrics 指标口径', () => {
  it('对白占比：成对引号内 CJK / 总 CJK（「」内算、引号外不算）', () => {
    const body = '林渡点头。他把铜钱收进怀里。\n\n「走吧。」他说。';
    const m = voiceMetrics('t', body);
    // CJK 总数：林渡点头(4)+他把铜钱收进怀里(8)+走吧(2)+他说(2)=16，对白内=走吧(2)
    expect(m.cjkChars).toBe(16);
    expect(m.dialogueRatio).toBe(0.13); // 2/16=0.125 → round2 0.13
  });

  it('引号不跨行配对：上行未闭合的「只影响本行，不吞下行', () => {
    const m = voiceMetrics('t', '「未闭合\n第二行正文。');
    expect(m.dialogueRatio).toBe(0.38); // 行内未闭合仍按对白计（未闭合 3 字 / 全文 8 字）；下行不再被吞
  });

  it('句长分布：短句/长句占比与中位数', () => {
    const m = voiceMetrics('t', `${SHORT}${SHORT}${LONG}`);
    expect(m.sentenceCount).toBe(3);
    expect(m.shortSentenceRatio).toBe(0.7); // 3,3 短 / 60 长
    expect(m.longSentenceRatio).toBe(0.3);
    expect(m.sentenceLenP50).toBe(3); // 升序 [3,3,60] 中位=3
    expect(m.sentenceLenMean).toBe(22); // (3+3+60)/3
  });

  it('高频二字组：相邻 CJK 滑窗计数，≥2 次才入榜', () => {
    const m = voiceMetrics('t', '林渡看铜钱，林渡看铜钱。');
    expect(m.topGrams).toContainEqual({ gram: '林渡', n: 2 });
    expect(m.topGrams).toContainEqual({ gram: '铜钱', n: 2 });
  });
});

describe('compareVoice 偏离对照（阈值写死）', () => {
  const base = voiceMetrics('b', '他说。她答。'.repeat(30) + `「${'话'.repeat(40)}。」`); // 160 CJK 过门控
  const quiet = voiceMetrics('o', `${LONG.repeat(3)}${'静'.repeat(20)}。`);
  const same = voiceMetrics('s2', '他说。她答。'.repeat(30) + `「${'话'.repeat(40)}。」`);

  it('对白占比骤降与句长骤增都出提示', () => {
    const d = compareVoice(base, quiet);
    expect(d.flags.some((f) => f.startsWith('对白占比'))).toBe(true);
    expect(d.flags.some((f) => f.startsWith('平均句长'))).toBe(true);
    expect(d.deltas.dialogueRatio.base).toBeGreaterThan(d.deltas.dialogueRatio.out);
  });

  it('同款文本零提示；deltas 恒在', () => {
    const d = compareVoice(base, same);
    expect(d.flags).toEqual([]);
    expect(d.deltas.sentenceLenMean.base).toBe(d.deltas.sentenceLenMean.out);
  });

  it('样本 CJK 不足 100 字：不出任何提示（信号量门控）', () => {
    const tiny = voiceMetrics('t', '短。');
    expect(compareVoice(base, tiny).flags).toEqual([]);
    expect(compareVoice(tiny, tiny).flags).toEqual([]);
  });

  it('惯用二字组零重合出提示（双方 top8 满）', () => {
    const a = voiceMetrics('a', '甲一甲二。'.repeat(20) + '乙一乙二。'.repeat(20) + '丙一丙二。'.repeat(20));
    const b = voiceMetrics('b', '丁一丁二。'.repeat(20) + '戊一戊二。'.repeat(20) + '己一己二。'.repeat(20));
    expect(compareVoice(a, b).flags.some((f) => f.startsWith('惯用二字组'))).toBe(true);
  });
});

describe('voiceFingerprint 取样三态与对照', () => {
  it('全书模式（缺省）：逐章取样，frontmatter 剥离', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第1章.md': `---\ntitle: 一\n---\n${SHORT}`,
      'manuscript/第2章.md': `---\ntitle: 二\n---\n${LONG}`,
    });
    const r = voiceFingerprint({ workDir: work });
    expect(r.samples.map((s) => s.key)).toEqual(['manuscript/第1章.md', 'manuscript/第2章.md']);
    expect(r.samples[0]!.cjkChars).toBe(3); // title 的「一」在 frontmatter 里，不计数
    expect(r.deviation).toBeUndefined();
  });

  it('relPaths 模式缺 workDir 报错；无样本报错', () => {
    expect(() => voiceFingerprint({ relPaths: ['manuscript/第1章.md'] })).toThrow('workDir');
    expect(() => voiceFingerprint({})).toThrow('无样本');
  });

  it('texts+compare 内联对照（core 续写/改写管道的用法）', () => {
    const r = voiceFingerprint({
      texts: ['他说。她答。'.repeat(30) + `「${'话'.repeat(40)}。」`, LONG.repeat(3)],
      compare: { baselineIndex: 0, sampleIndex: 1 },
    });
    expect(r.samples.map((s) => s.key)).toEqual(['text:0', 'text:1']);
    expect(r.deviation!.flags.length).toBeGreaterThan(0);
  });

  it('compare 下标越界中文报错', () => {
    expect(() => voiceFingerprint({ texts: ['正文。'], compare: { baselineIndex: 0, sampleIndex: 5 } })).toThrow('越界');
  });

  it('全书模式空 manuscript 报错', () => {
    const work = makeWorkDir();
    writeTree(work, { 'notes.md': 'x' });
    expect(() => voiceFingerprint({ workDir: work })).toThrow('未找到任何章');
  });
});

describe('read_style（块2·② 档案全文读回）', () => {
  it('缺失返回 exists=false；写入后读回全文 round-trip', async () => {
    const { readStyle, writeMeta } = await import('../src/ledger.js');
    const work = makeWorkDir();
    expect(readStyle(work)).toEqual({ exists: false });
    const content = '---\nkind: style\n---\n## 摘要\n短句为主。\n';
    writeMeta(work, path.join('.novel', 'style.md'), content);
    const r = readStyle(work);
    expect(r).toMatchObject({ exists: true, relPath: '.novel/style.md', content });
  });
});
