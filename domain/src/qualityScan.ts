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
import { assertWorkDir, collectMdFiles, toPosix } from './fsutil.js';

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

/**
 * 高频词：CJK 双字/三字 n-gram 词频（无分词器的确定性近似）。
 * >5 次/章 = 异常（writing-novel 阶段三清单）；3–5 次为候选（novel-improver 重复形容词 ≤3）。
 * 输出为候选清单而非判决——是否“异常”由人确认。
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
    .filter(([, n]) => n >= 3)
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
    const hitLine = lines.find((l) => !HEADING_RE.test(l.text.trim()) && l.text.includes(ng));
    hits.push({
      line: hitLine?.line ?? 0,
      text: `${ng} ×${n}：${hitLine ? hitLine.text.slice(0, EXCERPT_LEN) : ''}`,
    });
  }
  const severity: Severity = worst >= NGRAM_FAIL ? 'fail' : worst >= NGRAM_WARN ? 'warn' : 'pass';
  return {
    key: 'highFreq',
    label: '高频词（n-gram 候选）',
    standard: `同词 >${NGRAM_FAIL - 1} 次/章 = 异常；≥${NGRAM_WARN} 次为候选（无分词器近似）`,
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
 * scanWork：扫描 workDir/manuscript 下全部章（逐章读文件，只读不写）。
 * 输出逐章指标 + 书级指标。manuscript 不存在或为空时返回空结果。
 */
export function scanWork(workDir: string): WorkScanResult {
  const wd = assertWorkDir(workDir);
  const files = collectMdFiles(path.join(wd, 'manuscript'));
  const raws: RawChapter[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = fs.readFileSync(f.abs, 'utf8');
    } catch {
      continue; // 读取失败的文件跳过（与 search_content 一致）
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
  };
}


