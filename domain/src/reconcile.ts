/**
 * reconcile.ts —— 账本证据锚对账器（决策 0013 决策 3 的落地：锚要能回验）。
 *
 * 干什么：读账本（.novel/ledger.md），对四维里所有「证据锚」逐一回验——
 * 时钟表 chapters[] 每个章引用、道具托管链每步、伏笔 setups[]/payoffs[] 每条、知情地图每条 fact 的 since。
 * 锚 schema（chapter + 可选 line + 可选 quote）出处：决策 0013 证据锚统一 schema（ledger.ts 的
 * CustodyStep/PromiseSetup/PromisePayoff/KnowledgeFact.quote）。
 *
 * 判定规则（按序，一个锚点最多出一条 finding，全部确定性、只读正文不注入、纪律=永不产 BLOCKER）：
 * 1. 章引用不在 chapterOrder → anchor-chapter-missing，MAJOR/CONT（章被删/改名，账本悬空）；
 * 2. 章存在且有 quote：locateQuoteLine 找不到 → anchor-quote-missing，MAJOR/CONT（账本抽错或正文已改）；
 * 3. 章存在、有 quote 且记录了 line：定位行号 ≠ 记录行号 → anchor-line-drift，MINOR/CONT（行号漂移是编辑常态，提示级）；
 * 4. 以上都不中 → ok。无 quote 无 line 的纯章引用锚只查章存在性。
 *
 * 宁缺毋滥：locateQuoteLine 对「文件缺失」与「quote 不在」都返回 null 无法区分——章在 chapterOrder 内
 * 即文件应在，若读取异常（权限/IO 等）则 catch 住记 skipped 并跳过该锚，不产 finding；被跳过的锚不计入 checked。
 * findings 排序稳定可测：severity 权重 MAJOR>MINOR，同级按 code 字典序，再按 message。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chapterOrderForWork, locateQuoteLine, readLedger, type ChapterRef, type LedgerFinding } from './ledger.js';
import { assertWorkDir, errText, type SkippedEntry } from './fsutil.js';

/** 证据锚回验分类计数（checked = ok + chapterMissing + quoteMissing + lineDrift，自洽）。 */
export interface ReconcileAnchorsSummary {
  /** 回验锚点总数（每个章引用/链步/setup/payoff/since 各算一个；skipped 的锚不计入）。 */
  checked: number;
  ok: number;
  chapterMissing: number;
  quoteMissing: number;
  lineDrift: number;
}

/** 对账结果：anchors 计数 + findings（复用 LedgerFinding）+ 可选 skipped（章文件读取失败等）。 */
export interface ReconcileResult {
  workDir: string;
  anchors: ReconcileAnchorsSummary;
  findings: LedgerFinding[];
  /** 章文件读取失败等被跳过的锚点来源说明；空时不出现（照现有惯例）。 */
  skipped?: SkippedEntry[];
}

/** 单个待回验锚点：来源描述（拼 message 用）+ 定位三元组（chapter 必有，line/quote 可选）。 */
interface Anchor {
  source: string;
  chapter: string;
  line?: number;
  quote?: string;
}

/** quote 截断到 ≤40 字（超出补 …），供 message 引用。 */
function truncQuote(q: string): string {
  const t = q.trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

/**
 * reconcileLedger：对账入口。账本不存在 = 空账本 → checked 0、空 findings，不抛错。
 * 只读正文（locateQuoteLine 内部逐行匹配），绝不把正文注入上下文。
 */
export function reconcileLedger(workDir: string, ledgerPath?: string): ReconcileResult {
  const wd = assertWorkDir(workDir);
  const { ledger } = readLedger(wd, ledgerPath); // 账本不存在时返回空账本，不抛错
  const order = chapterOrderForWork(wd);
  const orderIndex = new Set(order.map((c: ChapterRef) => c.relPath));

  // 收集所有锚点（顺序无关紧要：findings 最终统一排序）
  const anchors: Anchor[] = [];
  for (const row of ledger.clock) {
    for (const chapter of row.chapters) {
      anchors.push({ source: '时钟表', chapter });
    }
  }
  for (const prop of ledger.props) {
    for (const step of prop.custody) {
      anchors.push({ source: `道具托管「${prop.name}」`, chapter: step.chapter, ...(step.line !== undefined ? { line: step.line } : {}), ...(step.quote !== undefined ? { quote: step.quote } : {}) });
    }
  }
  for (const p of ledger.promises) {
    for (const s of p.setups) {
      anchors.push({ source: `伏笔 ${p.id}「${p.name}」埋设`, chapter: s.chapter, ...(s.line !== undefined ? { line: s.line } : {}), ...(s.quote !== undefined ? { quote: s.quote } : {}) });
    }
    for (const x of p.payoffs) {
      anchors.push({ source: `伏笔 ${p.id}「${p.name}」回收`, chapter: x.chapter, ...(x.line !== undefined ? { line: x.line } : {}), ...(x.quote !== undefined ? { quote: x.quote } : {}) });
    }
  }
  for (const k of ledger.knowledge) {
    for (const f of [...k.knows, ...(k.doesNotKnow ?? [])]) {
      if (f.since === undefined) continue; // 无时间锚的知情事实没有章可查（宁缺毋滥）
      anchors.push({ source: `知情「${k.character}」since`, chapter: f.since, ...(f.quote !== undefined ? { quote: f.quote } : {}) });
    }
  }

  const summary: ReconcileAnchorsSummary = { checked: 0, ok: 0, chapterMissing: 0, quoteMissing: 0, lineDrift: 0 };
  const findings: LedgerFinding[] = [];
  const skipped: SkippedEntry[] = [];

  for (const a of anchors) {
    if (!orderIndex.has(a.chapter)) {
      summary.checked += 1;
      summary.chapterMissing += 1;
      findings.push({
        code: 'anchor-chapter-missing',
        chapter: a.chapter,
        severity: 'MAJOR',
        category: 'CONT',
        message: `${a.source}锚指向不存在的章：${a.chapter}（章被删/改名，账本悬空）`,
      });
      continue;
    }
    if (a.quote === undefined) {
      // 无 quote 锚（含只记 line 的）：line 脱离 quote 无法独立回验（宁缺毋滥），只查章存在性
      summary.checked += 1;
      summary.ok += 1;
      continue;
    }
    // 有 quote：需要读正文。先探文件可读性——locateQuoteLine 对文件缺失也返回 null，
    // 章在 chapterOrder 但读不到属于异常情况（权限/IO），进 skipped 不产 finding。
    try {
      fs.readFileSync(path.join(wd, a.chapter), 'utf8');
    } catch (err) {
      skipped.push({ path: a.chapter, reason: errText(err) });
      continue; // 被跳过的锚不计入 checked
    }
    summary.checked += 1;
    const actual = locateQuoteLine(workDir, a.chapter, a.quote.trim());
    if (actual === null) {
      summary.quoteMissing += 1;
      findings.push({
        code: 'anchor-quote-missing',
        chapter: a.chapter,
        severity: 'MAJOR',
        category: 'CONT',
        message: `${a.source}锚的原文引用在章中找不到：「${truncQuote(a.quote)}」（${a.chapter}，账本抽错或正文已改）`,
      });
      continue;
    }
    if (a.line !== undefined && actual !== a.line) {
      summary.lineDrift += 1;
      findings.push({
        code: 'anchor-line-drift',
        chapter: a.chapter,
        severity: 'MINOR',
        category: 'CONT',
        message: `${a.source}锚记录行号 ${a.line} 与实际定位行号 ${actual} 不一致（${a.chapter}，编辑后行号漂移，提示级）`,
      });
      continue;
    }
    summary.ok += 1;
  }

  // 稳定排序：severity 权重 MAJOR>MINOR，同级按 code 字典序，再按 message
  const sevWeight = (s: LedgerFinding['severity']): number => (s === 'BLOCKER' ? 0 : s === 'MAJOR' ? 1 : s === 'MODERATE' ? 2 : s === 'MINOR' ? 3 : 4);
  findings.sort((x, y) => sevWeight(x.severity) - sevWeight(y.severity) || (x.code < y.code ? -1 : x.code > y.code ? 1 : 0) || (x.message < y.message ? -1 : x.message > y.message ? 1 : 0));

  return {
    workDir,
    anchors: summary,
    findings,
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}
