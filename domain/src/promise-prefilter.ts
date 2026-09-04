/**
 * promise-prefilter.ts —— 承诺·伏笔维确定性预筛（reference/05 §扫描器分工；4.2 薄切片批）。
 *
 * 零 LLM：正文嫌疑句式（承诺/约定/欠偿类谓词）× 账本已登记承诺对照 → 每章嫌疑清单。
 * 分工边界：预筛只产候选（确定性），LLM 原子声明抽取与账本双向匹配（core 扫描管线）做发现，
 * 提案必经收件箱作者裁决。噪音预期按 F1≈0.68 设计——预筛宽（宁多勿漏），裁决层收窄。
 * 超域规约：命中嫌疑句式但账本无对应登记 → 标「未登记候选」显式入清单（不得静默丢弃）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { frontmatterEnd } from './frontmatter.js';
import { assertWorkDir, errText, resolveInsidePosix } from './fsutil.js';
import type { ChapterRef, Ledger, PromiseEntry } from './ledger.js';

/** 承诺/伏笔嫌疑谓词（宽口径，裁决层收窄；「宁缺毋滥」管诊断不管预筛——预筛宁多勿漏）。 */
const SUSPICION_RE =
  /(答应|承诺|发誓|起誓|保证|约定|许诺|许下|允诺|应允|迟早|总有一天|总有一日|改天|日后|他日|来日|迟早要|早晚|记住这笔|记下这笔|欠下|欠着|报答|报恩|复仇|讨回|讨还|偿还|还清|绝不会放过|一定要找到|一定会回来)/;

export interface SuspicionHit {
  /** 章内 1 起始行号。 */
  line: number;
  /** 触发句（截断 80 字符）。 */
  quote: string;
  /** 命中的谓词。 */
  predicate: string;
  /** 句中出现的已登记承诺名/别名（有=关联候选，无=未登记候选）。 */
  matchedPromiseIds: string[];
}

export interface ChapterPrefilter {
  chapterRelPath: string;
  hits: SuspicionHit[];
  /** 未登记候选数（命中嫌疑但无账本关联——超域规约显式计数）。 */
  unregistered: number;
}

export interface PrefilterResult {
  /** 有嫌疑的章（按章序）；无嫌疑章不列出（台账诚实：覆盖率由扫描窗口记录）。 */
  chapters: ChapterPrefilter[];
  scanned: number;
  /** 已登记承诺在册数（对照基数）。 */
  registeredPromises: number;
}

/** 已登记承诺的匹配词表（name 全串 + id；去空白小写规范化）。 */
function promiseTerms(promises: PromiseEntry[]): { id: string; terms: string[] }[] {
  return promises.map((p) => ({
    id: p.id,
    terms: [p.name, p.id].filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((t) => t.replace(/\s+/g, '')),
  }));
}

function matchPromises(sentence: string, terms: { id: string; terms: string[] }[]): string[] {
  const norm = sentence.replace(/\s+/g, '');
  return terms.filter((t) => t.terms.some((term) => term.length >= 2 && norm.includes(term))).map((t) => t.id);
}

/** 确定性预筛核心（纯函数可独立测试）。 */
export function prefilterChapter(body: string, ledger: Ledger): SuspicionHit[] {
  const terms = promiseTerms(ledger.promises);
  const lines = body.split('\n');
  const hits: SuspicionHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(SUSPICION_RE);
    if (!m) continue;
    hits.push({
      line: i + 1,
      quote: line.trim().slice(0, 80),
      predicate: m[1]!,
      matchedPromiseIds: matchPromises(line, terms),
    });
  }
  return hits;
}

/** workDir 入口：对指定章（缺省=全部章序）跑预筛。 */
export function promisePrefilter(workDir: string, opts?: { chapterRelPaths?: string[] | undefined; ledger?: Ledger | undefined; chapterOrder?: ChapterRef[] | undefined }): PrefilterResult {
  const wd = assertWorkDir(workDir);
  const ledger = opts?.ledger ?? { promises: [], clock: [], props: [], knowledge: [], doNotReexplain: [], protect: [], tripwires: [] };
  const order = opts?.chapterOrder ?? [];
  const targets = opts?.chapterRelPaths ?? order.map((c) => c.relPath);
  const chapters: ChapterPrefilter[] = [];
  for (const rel of targets) {
    // 先归一化+符号链接落点校验，再对归一化 posix 做白名单判断（fsutil 安全契约；防 manuscript/../ 未归一化绕过）
    let abs: string;
    let posix: string;
    try {
      ({ abs, posix } = resolveInsidePosix(wd, rel));
    } catch (err) {
      throw new Error(`预筛章路径不合法: ${rel}（${errText(err)}）`);
    }
    if (!posix.startsWith('manuscript/') || !posix.toLowerCase().endsWith('.md')) {
      throw new Error(`promisePrefilter 只允许 manuscript/ 内的 .md: ${rel}`);
    }
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`预筛章不存在: ${rel}`);
      throw err; // 权限/占用等读错误不再伪装成「章不存在」
    }
    const body = content.slice(frontmatterEnd(content));
    const hits = prefilterChapter(body, ledger);
    if (hits.length > 0) {
      chapters.push({ chapterRelPath: posix, hits, unregistered: hits.filter((h) => h.matchedPromiseIds.length === 0).length });
    }
  }
  return { chapters, scanned: targets.length, registeredPromises: ledger.promises.length };
}
