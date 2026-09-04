/**
 * character-prefilter.ts —— 角色维确定性预筛（reference/05 §角色维+扫描器分工；4.3 角色卡批）。
 *
 * 零 LLM：正文扫描已知名/别名提及（词典+称谓形态归一）+ 超域疑似（高频未命中候选——超域处置规约
 * 「不得静默丢弃」的产出端，由裁决回路定去留）+ 同一人多写法嫌疑（编辑距离 1，character-norm）。
 * 候选挖掘口径（name-census 仪器 2026-08-28 实测校准的产品化子集）：句首 2–4 字 + 「X 说/道/问」归属形态。
 * 局限记档：纯宾语态角色会漏、高频非人名词会混（stoplist 压制但不为零）——宁多勿漏，裁决层收窄。
 */
import fs from 'node:fs';
import { frontmatterEnd } from './frontmatter.js';
import { assertWorkDir, errText, resolveInsidePosix } from './fsutil.js';
import { matchName, normalizeName, samePersonVariants, type VariantSuspect } from './character-norm.js';
import type { ChapterRef, CharacterEntry, Ledger } from './ledger.js';

export interface NameMention {
  /** 已登记名（登记形态）。 */
  name: string;
  count: number;
  /** 提及章（按章序去重，最多记 10 章）。 */
  chapters: string[];
}

export interface UnknownCandidate {
  /** 未登记候选（归一化形态）。 */
  name: string;
  count: number;
  /** 首次提及章。 */
  firstChapter: string;
}

export interface CharacterPrefilterResult {
  scanned: number;
  /** 已知名/别名提及（词典命中）。 */
  mentions: NameMention[];
  /** 超域疑似（count ≥ minCount 才收——「高频」门槛；由裁决回路定去留）。 */
  unknownCandidates: UnknownCandidate[];
  /** 同一人多写法嫌疑。 */
  variantSuspects: VariantSuspect[];
}

/** 句子切分（。！？…\n；引号内短句也切）。 */
function sentences(body: string): string[] {
  return body.split(/[。！？…\n]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
}

/** 候选挖掘：句首 2–4 字 + 「X 说/道/问/喊/答」归属形态。 */
function candidateNames(body: string): string[] {
  const out: string[] = [];
  for (const s of sentences(body)) {
    const clean = s.replace(/[「」『』"'\s，、：；——]/g, '');
    const head = clean.slice(0, 4);
    if (head.length >= 2) {
      out.push(head.slice(0, 2), head.slice(0, 3), head.slice(0, 4));
    }
    for (const m of clean.matchAll(/([\u4e00-\u9fff]{2,4})(?=说|道|问|喊|答|笑|叹)/g)) {
      out.push(m[1]!);
    }
  }
  return out;
}

function countBy(names: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return counts;
}

/**
 * 角色维确定性预筛核心（纯函数可独立测试）：正文 × 角色词典 → 提及/超域疑似/写法变体。
 */
export function prefilterCharacters(body: string, entries: CharacterEntry[], opts?: { minCount?: number }): Omit<CharacterPrefilterResult, 'scanned'> {
  const minCount = opts?.minCount ?? 3;
  const mentions = new Map<string, NameMention>();
  for (const e of entries) {
    for (const n of [e.name, ...(e.aliases ?? [])]) {
      if (!n || n.length < 2) continue;
      let count = 0;
      let idx = body.indexOf(n);
      while (idx >= 0) {
        count++;
        idx = body.indexOf(n, idx + n.length);
      }
      if (count > 0) {
        const prev = mentions.get(e.name);
        if (prev) prev.count += count;
        else mentions.set(e.name, { name: e.name, count, chapters: [] });
      }
    }
  }
  const unknown = new Map<string, UnknownCandidate>();
  for (const cand of candidateNames(body)) {
    const norm = normalizeName(cand);
    if (norm.length < 2) continue;
    if (matchName(cand, entries)) continue; // 词典命中=提及，非超域
    const prev = unknown.get(norm);
    if (prev) prev.count++;
    else unknown.set(norm, { name: norm, count: 1, firstChapter: '' });
  }
  return {
    mentions: [...mentions.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    unknownCandidates: [...unknown.values()]
      .filter((c) => c.count >= minCount)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    variantSuspects: samePersonVariants(body, entries),
  };
}

/** workDir 入口：对指定章（缺省=全部章序）跑角色维预筛（逐章喂 mentions.chapters/firstChapter 定位）。 */
export function characterPrefilter(workDir: string, opts?: { chapterRelPaths?: string[] | undefined; ledger?: Ledger | undefined; chapterOrder?: ChapterRef[] | undefined; minCount?: number | undefined }): CharacterPrefilterResult {
  const wd = assertWorkDir(workDir);
  const entries = opts?.ledger?.characters ?? [];
  const order = opts?.chapterOrder ?? [];
  const targets = opts?.chapterRelPaths ?? order.map((c) => c.relPath);
  const mentions = new Map<string, NameMention>();
  const unknown = new Map<string, UnknownCandidate>();
  let variants: VariantSuspect[] = [];
  for (const rel of targets) {
    let abs: string;
    let posix: string;
    try {
      ({ abs, posix } = resolveInsidePosix(wd, rel));
    } catch (err) {
      throw new Error(`预筛章路径不合法: ${rel}（${errText(err)}）`);
    }
    if (!posix.startsWith('manuscript/') || !posix.toLowerCase().endsWith('.md')) {
      throw new Error(`characterPrefilter 只允许 manuscript/ 内的 .md: ${rel}`);
    }
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`预筛章不存在: ${rel}`);
      throw err;
    }
    const body = content.slice(frontmatterEnd(content));
    const part = prefilterCharacters(body, entries, { minCount: opts?.minCount ?? 3 });
    for (const m of part.mentions) {
      const prev = mentions.get(m.name);
      if (prev) {
        prev.count += m.count;
        if (prev.chapters.length < 10 && !prev.chapters.includes(posix)) prev.chapters.push(posix);
      } else mentions.set(m.name, { name: m.name, count: m.count, chapters: [posix] });
    }
    for (const c of part.unknownCandidates) {
      const prev = unknown.get(c.name);
      if (prev) prev.count += c.count;
      else unknown.set(c.name, { ...c, firstChapter: posix });
    }
    variants = variants.concat(part.variantSuspects);
  }
  // 跨章聚合后重跑 minCount 门槛（逐章过门槛的候选并入后再滤一次）
  const merged = [...unknown.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).filter((c) => c.count >= (opts?.minCount ?? 3));
  const variantMerged = new Map<string, VariantSuspect>();
  for (const v of variants) {
    const prev = variantMerged.get(v.variant);
    if (prev) prev.count += v.count;
    else variantMerged.set(v.variant, { ...v });
  }
  return {
    scanned: targets.length,
    mentions: [...mentions.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    unknownCandidates: merged,
    variantSuspects: [...variantMerged.values()].sort((a, b) => b.count - a.count || a.variant.localeCompare(b.variant)),
  };
}
