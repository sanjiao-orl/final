/**
 * quality_scan.test.ts —— LAY 量化指标扫描器：单项指标口径、阈值判定、书级指标、空作品。
 */
import { describe, expect, it } from 'vitest';
import { scanChapter, scanWork } from '../src/qualityScan.js';
import { makeWorkDir, writeTree } from './helpers.js';

function metricOf(content: string, key: string, relPath = '', title = '') {
  const ch = scanChapter(content, relPath, title);
  const m = ch.metrics.find((x) => x.key === key);
  if (!m) throw new Error(`指标不存在: ${key}`);
  return m;
}

describe('cjk 字数', () => {
  it('只计汉字，标点/字母/数字/空白不计', () => {
    expect(metricOf('正文十一个字符。abc 123', 'cjk').count).toBe(7);
  });

  it('≥1800 通过；1500–1799 警告；<1500 超标', () => {
    expect(metricOf('字'.repeat(1800), 'cjk').severity).toBe('pass');
    expect(metricOf('字'.repeat(1500), 'cjk').severity).toBe('warn');
    expect(metricOf('字'.repeat(1499), 'cjk').severity).toBe('fail');
  });

  it('frontmatter 不计入', () => {
    expect(metricOf('---\ntitle: 第一章\n---\n正文', 'cjk').count).toBe(2);
  });
});

describe('破折号', () => {
  it('统计 —— 对数，≤20 通过', () => {
    expect(metricOf('他说——不，等等——再说。', 'dash').count).toBe(2);
    expect(metricOf('——'.repeat(20), 'dash').severity).toBe('pass');
  });

  it('>20 超标', () => {
    const m = metricOf('——'.repeat(21), 'dash');
    expect(m.count).toBe(21);
    expect(m.severity).toBe('fail');
  });
});

describe('“不是X是Y”句式', () => {
  it('LAY 原正则变体：不是X——是Y', () => {
    const m = metricOf('他不是怕死——是怕连累别人。', 'notShi');
    expect(m.count).toBe(1);
    expect(m.severity).toBe('pass');
  });

  it('逗号与而是变体同计', () => {
    expect(metricOf('不是怕断电，是怕断信号。', 'notShi').count).toBe(1);
    expect(metricOf('不是麻绳，而是褪成灰白色的细丝绳。', 'notShi').count).toBe(1);
  });

  it('X 少于 2 字不计数（LAY 正则要求 2–30 字）', () => {
    expect(metricOf('不是人——是鬼。', 'notShi').count).toBe(0);
  });

  it('口语“不是”不带结构不计数', () => {
    expect(metricOf('这不是你的东西。', 'notShi').count).toBe(0);
  });

  it('阈值：≤2 通过，3 警告，>3 超标', () => {
    const three = '他不是怕死——是怕冷。他不是怕黑——是怕光。他不是怕饿——是怕咸。';
    expect(metricOf(three, 'notShi').severity).toBe('warn');
    const four = three + '他不是怕闷——是怕风。';
    expect(metricOf(four, 'notShi').severity).toBe('fail');
  });
});

describe('正文元话语', () => {
  it('卷N/第N章/前文/后文/本章 均计命中并超标', () => {
    const body = '这一卷一的设定要讲清楚。\n第三章的内容前文所述，后文再表，本章先略。';
    const m = metricOf(body, 'metaDiscourse');
    expect(m.count).toBeGreaterThanOrEqual(5);
    expect(m.severity).toBe('fail');
  });

  it('frontmatter 中的“第一章”不计数', () => {
    expect(metricOf('---\ntitle: 第一章\n---\n正文', 'metaDiscourse').count).toBe(0);
  });

  it('行号含 frontmatter 行（正文首行 = 文件第 4 行）', () => {
    const m = metricOf('---\ntitle: 一\n---\n前文说过这事。', 'metaDiscourse');
    expect(m.hits[0]!.line).toBe(4);
  });
});

describe('段落长度', () => {
  it('≤200 通过；200–300 警告；>300 超标', () => {
    const short = '字'.repeat(200);
    expect(metricOf(short, 'paragraphLength').severity).toBe('pass');
    expect(metricOf('字'.repeat(250), 'paragraphLength').severity).toBe('warn');
    expect(metricOf('字'.repeat(350), 'paragraphLength').severity).toBe('fail');
  });

  it('### 标题行不参与段落长度判定', () => {
    const m = metricOf('### 临行\n\n字'.repeat(100), 'paragraphLength');
    expect(m.severity).toBe('pass');
  });
});

describe('AI 口水词', () => {
  it('清单词每处计命中并超标', () => {
    const body = '他缓缓站起来，不由得叹了口气。眼底闪过一道光，心中升起一股寒意。说不出的滋味，这意味着什么？';
    const m = metricOf(body, 'aiFiller');
    expect(m.count).toBe(6);
    expect(m.severity).toBe('fail');
  });

  it('无口水词通过', () => {
    expect(metricOf('他站起来，叹了口气。', 'aiFiller').severity).toBe('pass');
  });
});

describe('高频词（n-gram 候选）', () => {
  it('同词 >5 次/章 = 超标', () => {
    const body = '夜色沉沉，水声沉沉，风声沉沉，心事沉沉，灯影沉沉，人影沉沉，雨声沉沉。';
    const m = metricOf(body, 'highFreq');
    expect(m.count).toBeGreaterThan(0);
    expect(m.severity).toBe('fail');
    expect(m.hits.some((h) => h.text.startsWith('沉沉'))).toBe(true);
  });

  it('3–5 次为警告级候选', () => {
    const body = '夜色沉沉，水声沉沉，风声沉沉，心事沉沉。';
    expect(metricOf(body, 'highFreq').severity).toBe('warn');
  });

  it('无重复词通过', () => {
    expect(metricOf('山高水远路长人稀。', 'highFreq').severity).toBe('pass');
  });
});

describe('感叹号与粗口（信息项）', () => {
  it('感叹号报分布，severity 恒为 info', () => {
    const m = metricOf('快跑！救命！', 'exclamation');
    expect(m.count).toBe(2);
    expect(m.severity).toBe('info');
  });

  it('粗口报分布，长词优先不重复计数', () => {
    const m = metricOf('妈的，他妈的！', 'profanity');
    expect(m.count).toBe(2);
    expect(m.severity).toBe('info');
  });
});

describe('场景（### 场标题）', () => {
  it('解析场标题与行号', () => {
    const m = metricOf('### 临行\n正文一。\n\n### 下山\n正文二。', 'scenes');
    expect(m.count).toBe(2);
    expect(m.hits.map((h) => h.text)).toEqual(['临行', '下山']);
    expect(m.hits[0]!.line).toBe(1);
    expect(m.hits[1]!.line).toBe(4);
  });
});

describe('scanWork 书级指标', () => {
  it('多章：场景轮换池、连续同场景违规、跨章模板段落候选', () => {
    const work = makeWorkDir();
    const open = '这是一段完全一样的段落开头文字，用来检测跨章模板段落。';
    writeTree(work, {
      'manuscript/卷一/a.md': '---\ntitle: 一\n---\n### 密室\n\n' + open,
      'manuscript/卷一/b.md': '### 密室\n\n' + open,
      'manuscript/卷一/c.md': '### 密室\n\n' + '不同的段落开头，这里没有重复。',
    });

    const res = scanWork(work);
    expect(res.chapters).toHaveLength(3);
    // 场景轮换池：全稿只有 1 个不同场标题
    expect(res.book.scenePool).toEqual(['密室']);
    // 同一场景连续 3 章 → 违规
    expect(res.book.sceneContinuity).toEqual([
      { scene: '密室', chapters: ['manuscript/卷一/a.md', 'manuscript/卷一/b.md', 'manuscript/卷一/c.md'] },
    ]);
    // 跨章模板段落：开头（前 20 CJK 字，去标点）出现在 2 个不同章
    const openCjk = open.replace(/[^\u3400-\u4dbf\u4e00-\u9fff]/g, '');
    expect(res.book.templateParagraphs).toEqual([
      { opening: openCjk.slice(0, 20), chapters: ['manuscript/卷一/a.md', 'manuscript/卷一/b.md'] },
    ]);
  });

  it('场景轮换池 ≥5 时不报违规', () => {
    const work = makeWorkDir();
    const scenes = ['临行', '下山', '茶棚', '夜宿', '市集'];
    const files: Record<string, string> = {};
    scenes.forEach((s, i) => {
      files[`manuscript/卷一/第${i + 1}章.md`] = `### ${s}\n\n正文。`;
    });
    writeTree(work, files);
    const res = scanWork(work);
    expect(res.book.scenePool).toEqual(scenes);
    expect(res.book.sceneContinuity).toEqual([]);
    expect(res.book.templateParagraphs).toEqual([]);
  });

  it('空作品：chapters 空、书级指标为空', () => {
    const res = scanWork(makeWorkDir());
    expect(res.chapters).toEqual([]);
    expect(res.book).toEqual({ scenePool: [], sceneContinuity: [], templateParagraphs: [] });
  });

  it('章标题取 frontmatter.title，缺省取文件名', () => {
    const work = makeWorkDir();
    writeTree(work, {
      'manuscript/第一章.md': '---\ntitle: 少年\n---\n正文。',
      'manuscript/第二章.md': '正文。',
    });
    const res = scanWork(work);
    expect(res.chapters.map((c) => c.title)).toEqual(['少年', '第二章']);
  });
});
