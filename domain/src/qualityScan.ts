/**
 * qualityScan.ts —— 去 AI 味量化指标扫描器（LAY 规则落地，确定性、零 LLM 成本）。
 *
 * 规则出处：LAY novel-writing-framework（MIT 规则文档，只借思路不借代码）——
 * skills/writing-novel.md / piqie-writing.md / qidian-writing.md / novel-improver.md。
 * 本实现完全自研：纯正则/计数扫描，逐章读文件，绝不把正文注入上下文（AGENTS.md 禁令）。
 *
 * 口径约定：
 * - CJK = 汉字（Unified Ideographs + Ext-A，与 LAY 检测命令一致），标点/字母数字不计；
 * - 行号 = 文件内 1 起始行号（含 frontmatter 行，与 search_content 口径一致）；
 * - 只扫正文：frontmatter 是结构元数据，不参与任何指标；
 * - 每项指标输出 count + severity（pass/warn/fail/info）+ 命中明细（行号+原行截断）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { frontmatterEnd, parseFrontmatter } from './frontmatter.js';
import { CHAPTER_NAME_RE, VOLUME_NAME_RE, assertWorkDir, collectMdFiles, compareNames, errText, toPosix, type SkippedEntry } from './fsutil.js';

export type Severity = 'pass' | 'warn' | 'fail' | 'info';

export interface ScanHit {
  /** 文件内 1 起始行号（含 frontmatter 行）。 */
  line: number;
  /** 命中行原文截断（超出 EXCERPT_LEN 字补 …）。 */
  text: string;
}

export interface Metric {
  /** 稳定英文键，供 JSON/表格消费。 */
  key: string;
  label: string;
  /** 标准描述（LAY 出处 + 阈值）。 */
  standard: string;
  count: number;
  severity: Severity;
  hits: ScanHit[];
  /** 命中超过 MAX_HITS 时的剩余条数。 */
  more?: number;
}

export interface ChapterScan {
  /** 相对 workDir 的路径（正斜杠）。 */
  relPath: string;
  title: string;
  metrics: Metric[];
}

export interface SceneContinuityViolation {
  /** ### 场标题。 */
  scene: string;
  /** 连续出现该场景的章 relPath（≥3 章才构成违规）。 */
  chapters: string[];
}

export interface TemplateParagraph {
  /** 段落开头（前 20 个 CJK 字）。 */
  opening: string;
  chapters: string[];
}

export interface BookScan {
  /** 场景轮换池：全稿去重 ### 场标题（LAY 建议 ≥5）。 */
  scenePool: string[];
  sceneContinuity: SceneContinuityViolation[];
  templateParagraphs: TemplateParagraph[];
}

export interface WorkScanResult {
  workDir: string;
  chapters: ChapterScan[];
  book: BookScan;
  /** 可选加法：读取失败被跳过的章/目录清单（空时不出现）；作者据此知道哪些章没扫到。 */
  skipped?: SkippedEntry[];
}

// ---------- 阈值常量（LAY 实际清单；改动需在报告里注明出处） ----------

/** CJK 每章目标/底线/红线（writing-novel 阶段二；novel-improver 硬性指标 ≥2000）。 */
export const CJK_TARGET = 2000;
export const CJK_BASELINE = 1800;
export const CJK_RED_LINE = 1500;
/** 破折号每章上限（novel-improver 硬性指标 ≤20）。 */
export const DASH_LIMIT = 20;
/** “不是X是Y”每章目标/底线（writing-novel 阶段二：≤2 目标、≤3 底线）。 */
export const NOTSHI_TARGET = 2;
export const NOTSHI_BASELINE = 3;
/** 段落长度：主要段落 ≤200 字（novel-improver）；>300 手机阅读不友好（writing-novel 阶段三清单）。 */
export const PARA_WARN = 200;
export const PARA_FAIL = 300;
/** 高频词：同词 >5 次/章 = 异常（writing-novel 阶段三清单）；novel-improver 重复形容词标准 ≤3。 */
export const NGRAM_FAIL = 6;
export const NGRAM_WARN = 4;
/** 高频词候选阈值：同词 ≥3 次/章进入候选（novel-improver 重复形容词 ≤3 口径；候选≠判决，供人工复核）。 */
export const NGRAM_CANDIDATE = 3;
/** 场景轮换池建议 ≥5 个（writing-novel 场景多样性）。 */
export const SCENE_POOL_MIN = 5;
/** 同一场景连续出现 ≤3 章（writing-novel/piqie 场景多样性）。 */
export const SCENE_CONTINUITY_MAX = 3;
/** 跨章模板段落候选：段落开头 ≥10 CJK 字、出现在 ≥2 个不同章（novel-improver 模板段落 0/单元）。 */
export const TEMPLATE_MIN_CJK = 10;
export const TEMPLATE_MIN_CHAPTERS = 2;

const MAX_HITS = 10;
const EXCERPT_LEN = 60;

// ---------- 基础工具 ----------

/** 汉字数（CJK Unified Ideographs + Ext-A，与 LAY 检测命令口径一致）。 */
export function countCjk(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff)) n += 1;
  }
  return n;
}

/** 场景标题：### 开头、后随内容（与 tools.ts 口径一致）。 */
const SCENE_RE = /^###[ \t]+(.+)$/;
const HEADING_RE = /^#/;

interface BodyLine {
  text: string;
  /** 文件内 1 起始行号。 */
  line: number;
}

interface Paragraph {
  /** 段落原文（多行拼接，去换行）。 */
  text: string;
  /** 段落首行行号。 */
  line: number;
  cjk: number;
}

/** 正文 → 带行号的行列表；baseLine = 正文首行在文件中的 1 起始行号。 */
function bodyLines(body: string, baseLine: number): BodyLine[] {
  const lines = body.split(/\r?\n/);
  return lines.map((text, i) => ({ text, line: baseLine + i }));
}

/** 按空行分组段落；纯标题段（### 等）保留但标记，不参与长度/模板检查。 */
function paragraphs(lines: BodyLine[]): Paragraph[] {
  const out: Paragraph[] = [];
  let cur: BodyLine[] = [];
  const flush = (): void => {
    if (cur.length === 0) return;
    const text = cur.map((l) => l.text.trim()).join('');
    out.push({ text, line: cur[0]!.line, cjk: countCjk(text) });
    cur = [];
  };
  for (const l of lines) {
    if (l.text.trim() === '') {
      flush();
    } else {
      cur.push(l);
    }
  }
  flush();
  return out;
}

/** 逐行扫描给定 token/正则，输出命中（行号 + 截断原文）。 */
function scanTokens(
  lines: BodyLine[],
  re: RegExp,
  maxHits = MAX_HITS,
): { count: number; hits: ScanHit[]; more: number } {
  const hits: ScanHit[] = [];
  let count = 0;
  let more = 0;
  for (const l of lines) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(l.text)) !== null) {
      count += 1;
      if (hits.length < maxHits) {
        hits.push({ line: l.line, text: l.text.slice(0, EXCERPT_LEN) });
      } else {
        more += 1;
      }
      if (m[0].length === 0) re.lastIndex += 1; // 防空匹配死循环
    }
  }
  return { count, hits, more };
}

// ---------- 单项指标 ----------

function metricCjk(body: string): Metric {
  const count = countCjk(body);
  const severity: Severity =
    count >= CJK_BASELINE ? 'pass' : count >= CJK_RED_LINE ? 'warn' : 'fail';
  return {
    key: 'cjk',
    label: 'CJK 字数',
    standard: `每章 ≥${CJK_TARGET}（目标）/${CJK_BASELINE}（底线）/${CJK_RED_LINE}（红线）`,
    count,
    severity,
    hits: [],
  };
}

function metricDash(lines: BodyLine[]): Metric {
  const { count, hits, more } = scanTokens(lines, /——/g);
  return {
    key: 'dash',
    label: '破折号 ——',
    standard: `每章 ≤${DASH_LIMIT} 个（超标建议脚本批量替换为中文逗号）`,
    count,
    severity: count > DASH_LIMIT ? 'fail' : 'pass',
    hits,
    more,
  };
}

/**
 * “不是X是Y”句式（LAY 头号 AI 指纹）：
 * - LAY 原正则 `/不是[^—]{2,30}——是/g`（此处 X 段排除换行，避免跨行误配）；
 * - 逗号变体“不是X，是Y”（piqie 铁律 1 明确同列）；
 * - “不是X而是Y”（novel-improver/zhi-dou 同列）。
 * 对话中不带“而是/，是/——是”结构的“不是”不计数（LAY：对话口语可保留）。
 */
function metricNotShi(lines: BodyLine[]): Metric {
  const pats = [
    { re: /不是[^—\n]{2,30}——是/g, label: '不是X——是Y' },
    { re: /不是[^，。；！？\n]{2,30}，是/g, label: '不是X，是Y' },
    { re: /不是[^。；！？\n]{2,30}而是/g, label: '不是X而是Y' },
  ];
  const hits: ScanHit[] = [];
  let count = 0;
  let more = 0;
  for (const l of lines) {
    const seen = new Set<number>();
    for (const p of pats) {
      let m: RegExpExecArray | null;
      p.re.lastIndex = 0;
      while ((m = p.re.exec(l.text)) !== null) {
        if (!seen.has(m.index)) {
          seen.add(m.index);
          count += 1;
          if (hits.length < MAX_HITS) {
            hits.push({ line: l.line, text: l.text.slice(0, EXCERPT_LEN) });
          } else {
            more += 1;
          }
        }
        if (m[0].length === 0) p.re.lastIndex += 1;
      }
    }
  }
  const severity: Severity =
    count > NOTSHI_BASELINE ? 'fail' : count > NOTSHI_TARGET ? 'warn' : 'pass';
  return {
    key: 'notShi',
    label: '“不是X是Y”句式',
    standard: `每章 ≤${NOTSHI_TARGET}（目标）/${NOTSHI_BASELINE}（底线），三种变体同计（——是/，是/而是）`,
    count,
    severity,
    hits,
    more,
  };
}

/** 正文元话语禁令：卷N、第N章、前文、后文、本章（writing-novel 正文禁止元话语）。 */
function metricMetaDiscourse(lines: BodyLine[]): Metric {
  const pats = [
    { re: /卷[一二三四五六七八九十百]+/g, label: '卷N' },
    { re: /第[一二三四五六七八九十百\d]+章/g, label: '第N章' },
    { re: /前文|后文|本章/g, label: '前文/后文/本章' },
  ];
  const hits: ScanHit[] = [];
  let count = 0;
  let more = 0;
  for (const l of lines) {
    const seen = new Set<number>();
    for (const p of pats) {
      let m: RegExpExecArray | null;
      p.re.lastIndex = 0;
      while ((m = p.re.exec(l.text)) !== null) {
        if (!seen.has(m.index)) {
          seen.add(m.index);
          count += 1;
          if (hits.length < MAX_HITS) {
            hits.push({ line: l.line, text: l.text.slice(0, EXCERPT_LEN) });
          } else {
            more += 1;
          }
        }
        if (m[0].length === 0) p.re.lastIndex += 1;
      }
    }
  }
  return {
    key: 'metaDiscourse',
    label: '正文元话语',
    standard: '正文 0 次（“卷一/卷二”“第X章”“前文”“后文”“本章”）',
    count,
    severity: count > 0 ? 'fail' : 'pass',
    hits,
    more,
  };
}

/** 段落长度：>200 字警告、>300 字超标（novel-improver / writing-novel 阶段三清单）。 */
function metricParagraphLength(paras: Paragraph[]): Metric {
  const hits: ScanHit[] = [];
  let count = 0;
  let more = 0;
  let worst = 0;
  for (const p of paras) {
    if (p.text.trim() === '' || HEADING_RE.test(p.text.trim())) continue;
    if (p.cjk > worst) worst = p.cjk;
    if (p.cjk <= PARA_WARN) continue;
    count += 1;
    if (hits.length < MAX_HITS) {
      hits.push({
        line: p.line,
        text: `${p.cjk} 字：${p.text.slice(0, EXCERPT_LEN)}`,
      });
    } else {
      more += 1;
    }
  }
  const severity: Severity = worst > PARA_FAIL ? 'fail' : worst > PARA_WARN ? 'warn' : 'pass';
  return {
    key: 'paragraphLength',
    label: '段落长度',
    standard: `主要段落 ≤${PARA_WARN} 字；>${PARA_FAIL} 字手机阅读不友好`,
    count,
    severity,
    hits,
    more,
  };
}

/** AI 口水词：0 次/章（novel-improver 硬性指标 + piqie 铁律 7 同清单）。 */
function metricAiFiller(lines: BodyLine[]): Metric {
  const { count, hits, more } = scanTokens(
    lines,
    /缓缓|不由得|眼底闪过|心中升起|说不出的|这意味着/g,
  );
  return {
    key: 'aiFiller',
    label: 'AI 口水词',
    standard: '每章 0 次（缓缓/不由得/眼底闪过/心中升起/说不出的/这意味着）',
    count,
    severity: count > 0 ? 'fail' : 'pass',
    hits,
    more,
  };
}

// ---------- 高频词误报过滤（WS-7 顺手改良：人名/停用词） ----------

/** 常见姓氏（百家姓子集，人名锚定用，T2 R5 思路的自研子集）。 */
const SURNAME_CHARS = new Set(
  '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴郁胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍郤璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公'.split(''),
);

/** 常见称谓/敬称（结构性重复，非词癖）。 */
const TITLE_WORDS = new Set([
  '师父', '师傅', '先生', '小姐', '少爷', '夫人', '老爷', '大人', '公子', '姑娘',
  '掌门', '长老', '师兄', '师姐', '师弟', '师妹', '前辈', '阁下', '殿下',
]);

/** 语气助词/虚词（n-gram 含此类字多为「的+名词」类功能词碎片，非内容重复）。 */
const GLUE_CHARS = new Set('的了着得地吗呢吧啊之乎者也'.split(''));

/**
 * 判定一个 CJK n-gram 是否应被高频词候选过滤（人名/称谓/功能词碎片）。
 * 仅过滤确定性高的结构重复，保留真正的词癖（作响/像是/十六年 等）。
 *
 * 已知误伤面（诚实标注，非缺陷修复项）：
 * - 姓氏锚定只认单字姓，复姓（司马/欧阳/上官/诸葛…）人名不会命中，仍会进候选；
 * - 凡以常见姓氏字开头的普通内容词（夏天/白天/黄沙/钟声/长江…）会被误当人名过滤，
 *   即使高频重复也不再进候选——这是「无分词器 + 无实体库」的确定性近似代价。
 *   此类结构性词由冷读（账本 PROTECT/do-not-re-explain）兜底判定，扫描器不承担最终裁决。
 */
export function isFilteredNgram(ng: string): boolean {
  if (TITLE_WORDS.has(ng)) return true;
  // 人名锚定：2–3 字、首字为姓氏、其余字不是虚词/姓氏（避免「的茶」「了之」误判）
  if (ng.length >= 2 && ng.length <= 3 && SURNAME_CHARS.has(ng[0]!)) {
    const rest = [...ng.slice(1)];
    if (rest.every((c) => !GLUE_CHARS.has(c) && !SURNAME_CHARS.has(c))) return true;
  }
  // 功能词碎片：含虚词（的/了/着/得/地…）
  if ([...ng].some((c) => GLUE_CHARS.has(c))) return true;
  return false;
}

/**
 * 高频词：CJK 双字/三字 n-gram 词频（无分词器的确定性近似）。
 * 口径统一（NGRAM_CANDIDATE）：同词 ≥3 次/章进入候选；≥4 次（NGRAM_WARN）警告；>5 次（NGRAM_FAIL）异常。
 * 人名/称谓/功能词碎片先经 isFilteredNgram 过滤（WS-7 顺手改良），其余仍为候选而非判决。
 */
function metricHighFreq(lines: BodyLine[]): Metric {
  // 去掉标题行后取纯 CJK 序列
  const cjk = lines
    .filter((l) => !HEADING_RE.test(l.text.trim()))
    .map((l) => l.text.replace(/[^\u3400-\u4dbf\u4e00-\u9fff]/g, ''))
    .join('');
  const freq = new Map<string, number>();
  for (let i = 0; i < cjk.length - 1; i++) {
    const bigram = cjk.slice(i, i + 2);
    freq.set(bigram, (freq.get(bigram) ?? 0) + 1);
  }
  for (let i = 0; i < cjk.length - 2; i++) {
    const trigram = cjk.slice(i, i + 3);
    freq.set(trigram, (freq.get(trigram) ?? 0) + 1);
  }
  const flagged = [...freq.entries()]
    .filter(([ng, n]) => n >= NGRAM_CANDIDATE && !isFilteredNgram(ng))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 15);
  let worst = 0;
  const hits: ScanHit[] = [];
  let more = 0;
  for (const [ng, n] of flagged) {
    if (n > worst) worst = n;
    if (hits.length >= MAX_HITS) {
      more += 1;
      continue;
    }
    // n-gram 由「跨行去标点拼接的 CJK 流」生成，可能不存在于任何单行 → 跳过该 hit，不产生 line:0
    const hitLine = lines.find((l) => !HEADING_RE.test(l.text.trim()) && l.text.includes(ng));
    if (!hitLine) continue;
    hits.push({
      line: hitLine.line,
      text: `${ng} ×${n}：${hitLine.text.slice(0, EXCERPT_LEN)}`,
    });
  }
  const severity: Severity = worst >= NGRAM_FAIL ? 'fail' : worst >= NGRAM_WARN ? 'warn' : 'pass';
  return {
    key: 'highFreq',
    label: '高频词（n-gram 候选）',
    standard: `同词 ≥${NGRAM_CANDIDATE} 次/章为候选；≥${NGRAM_WARN} 次警告；>${NGRAM_FAIL - 1} 次异常（人名/称谓/功能词碎片已过滤）`,
    count: flagged.length,
    severity,
    hits,
    more,
  };
}

/** 感叹号分布：信息项（LAY：战斗章 ≥2 个/章，章型需人工判定）。 */
function metricExclamation(lines: BodyLine[]): Metric {
  const { count, hits, more } = scanTokens(lines, /[！!]/g);
  return {
    key: 'exclamation',
    label: '感叹号',
    standard: '战斗章 ≥2 个/章（章型人工判定，此处仅报分布）',
    count,
    severity: 'info',
    hits,
    more,
  };
}

/** 粗口分布：信息项（LAY：按角色语音卡，无通用阈值）。 */
function metricProfanity(lines: BodyLine[]): Metric {
  const { count, hits, more } = scanTokens(
    lines,
    /他妈的|妈的|卧槽|操蛋|王八蛋|狗日的|混蛋|畜生/g,
  );
  return {
    key: 'profanity',
    label: '粗口',
    standard: '按角色语音卡（无通用阈值，仅报分布）',
    count,
    severity: 'info',
    hits,
    more,
  };
}

/** ### 场景清单（结构信息，供书级场景轮换/连续性指标用）。 */
function metricScenes(lines: BodyLine[]): { scenes: { title: string; line: number }[]; metric: Metric } {
  const scenes: { title: string; line: number }[] = [];
  for (const l of lines) {
    const m = SCENE_RE.exec(l.text.trim());
    if (m) scenes.push({ title: m[1]!.trim(), line: l.line });
  }
  const metric: Metric = {
    key: 'scenes',
    label: '场景（### 场标题）',
    standard: `本书轮换池 ≥${SCENE_POOL_MIN} 个（书级指标，见汇总）`,
    count: scenes.length,
    severity: 'info',
    hits: scenes.slice(0, MAX_HITS).map((s) => ({ line: s.line, text: s.title })),
    ...(scenes.length > MAX_HITS ? { more: scenes.length - MAX_HITS } : {}),
  };
  return { scenes, metric };
}

// ---------- 章级扫描 ----------

interface RawChapter {
  relPath: string;
  title: string;
  metrics: Metric[];
  scenes: { title: string; line: number }[];
  paragraphs: Paragraph[];
}

function scanChapterRaw(body: string, baseLine: number, relPath: string, title: string): RawChapter {
  const lines = bodyLines(body, baseLine);
  const paras = paragraphs(lines);
  const { scenes, metric: scenesMetric } = metricScenes(lines);
  const metrics: Metric[] = [
    metricCjk(body),
    metricDash(lines),
    metricNotShi(lines),
    metricMetaDiscourse(lines),
    metricParagraphLength(paras),
    metricAiFiller(lines),
    metricHighFreq(lines),
    metricExclamation(lines),
    metricProfanity(lines),
    scenesMetric,
  ];
  return { relPath, title, metrics, scenes, paragraphs: paras };
}

/**
 * scanChapter：扫单章文件内容（含 frontmatter，自动跳过）。
 * 行号 = 文件内 1 起始行号。
 */
export function scanChapter(content: string, relPath = '', title = ''): ChapterScan {
  const fmEnd = frontmatterEnd(content);
  const body = content.slice(fmEnd);
  const baseLine = fmEnd === 0 ? 1 : content.slice(0, fmEnd).split(/\r?\n/).length;
  if (!title) title = parseFrontmatter(content).title ?? '';
  const raw = scanChapterRaw(body, baseLine, relPath, title);
  return { relPath, title, metrics: raw.metrics };
}

// ---------- 书级指标 ----------

function computeBook(raws: RawChapter[]): BookScan {
  // 场景轮换池：全稿去重 ### 标题（按首次出现顺序）
  const pool: string[] = [];
  const seen = new Set<string>();
  for (const r of raws) {
    for (const s of r.scenes) {
      if (!seen.has(s.title)) {
        seen.add(s.title);
        pool.push(s.title);
      }
    }
  }

  // 同一场景连续 ≥3 章 → 违规
  const sceneContinuity: SceneContinuityViolation[] = [];
  if (raws.length >= SCENE_CONTINUITY_MAX) {
    for (const title of pool) {
      let run: string[] = [];
      let best: string[] = [];
      for (const r of raws) {
        if (r.scenes.some((s) => s.title === title)) {
          run.push(r.relPath);
          if (run.length > best.length) best = run.slice();
        } else {
          run = [];
        }
      }
      if (best.length >= SCENE_CONTINUITY_MAX) {
        sceneContinuity.push({ scene: title, chapters: best });
      }
    }
  }

  // 跨章模板段落候选：同一段落开头（前 20 CJK 字）出现在 ≥2 个不同章
  const openings = new Map<string, Set<string>>();
  for (const r of raws) {
    for (const p of r.paragraphs) {
      const text = p.text.trim();
      if (text === '' || HEADING_RE.test(text)) continue;
      const cjk = text.replace(/[^\u3400-\u4dbf\u4e00-\u9fff]/g, '');
      if (cjk.length < TEMPLATE_MIN_CJK) continue;
      const opening = cjk.slice(0, 20);
      const set = openings.get(opening) ?? new Set<string>();
      set.add(r.relPath);
      openings.set(opening, set);
    }
  }
  const templateParagraphs: TemplateParagraph[] = [...openings.entries()]
    .filter(([, chs]) => chs.size >= TEMPLATE_MIN_CHAPTERS)
    .map(([opening, chs]) => ({ opening, chapters: [...chs].sort() }))
    .sort((a, b) => (a.opening < b.opening ? -1 : 1));

  return { scenePool: pool, sceneContinuity, templateParagraphs };
}

/**
 * 章文件阅读序：按路径段逐段编号感知比较（卷段用 VOLUME_NAME_RE、文件名用 CHAPTER_NAME_RE，
 * 复用 fsutil.ts 的 compareNames）。collectMdFiles 的字典序在 >9 章阿拉伯编号或汉字编号时错序，
 * sceneContinuity/templateParagraphs 的「连续章」判定必须按真实阅读顺序。
 */
function compareChapterFiles(a: string, b: string): number {
  const sa = a.split(path.sep);
  const sb = b.split(path.sep);
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const pa = sa[i];
    const pb = sb[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    if (pa === pb) continue;
    const c = compareNames(pa, pb, i === len - 1 ? CHAPTER_NAME_RE : VOLUME_NAME_RE);
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * scanWork：扫描 workDir/manuscript 下全部章（逐章读文件，只读不写）。
 * 输出逐章指标 + 书级指标。manuscript 不存在或为空时返回空结果。
 */
export function scanWork(workDir: string): WorkScanResult {
  const wd = assertWorkDir(workDir);
  const skipped: SkippedEntry[] = [];
  const files = collectMdFiles(path.join(wd, 'manuscript'), (rel, err) => {
    skipped.push({ path: toPosix(path.join('manuscript', rel || '.')), reason: errText(err) });
  });
  // scan 前按编号感知阅读序重排章列表（字典序会在 >9 章/汉字编号时错序，见 compareChapterFiles）
  const raws: RawChapter[] = [];
  for (const f of [...files].sort((a, b) => compareChapterFiles(a.rel, b.rel))) {
    let content: string;
    try {
      content = fs.readFileSync(f.abs, 'utf8');
    } catch (err) {
      // 不再静默漏章：warn + 记入 skipped，让作者知道哪些章没扫到
      console.warn(`[scan_quality] 章读取失败已跳过: ${f.abs}（${errText(err)}）`);
      skipped.push({ path: toPosix(path.join('manuscript', f.rel)), reason: errText(err) });
      continue;
    }
    const fmEnd = frontmatterEnd(content);
    const body = content.slice(fmEnd);
    const baseLine = fmEnd === 0 ? 1 : content.slice(0, fmEnd).split(/\r?\n/).length;
    const fmTitle = parseFrontmatter(content).title;
    const title = fmTitle ?? path.basename(f.abs, '.md');
    raws.push(scanChapterRaw(body, baseLine, toPosix(path.join('manuscript', f.rel)), title));
  }
  return {
    workDir: wd,
    chapters: raws.map((r) => ({ relPath: r.relPath, title: r.title, metrics: r.metrics })),
    book: computeBook(raws),
    ...(skipped.length > 0 ? { skipped } : {}), // 可选加法：空时不出现，不改既有字段语义
  };
}


