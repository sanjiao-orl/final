/**
 * ledger-index.ts —— 最小索引层（reference/05 §批次结构 4.1；纯加法，不触碰既有 ledgerSlice 路径）。
 *
 * 边界（0905 总设计裁决钉死，只做两件确定物）：
 * 1. 按生效区间裁剪的信封切片器——activeAt(order) 过滤 + 预算内优先级裁剪（承重优先：promise > prop > knowledge > clock）；
 * 2. 名字/别名 → 区间条目的章级倒排——查询名命中后按区间裁剪注入。
 *
 * 实测依据（测量报告 §3）：基线臂 ledger_slice 44-49 万字符 >> 任何上下文——「按章过滤」已证失效，
 * 必须按区间裁剪；本模块在两个仪器账本上验收（切片压进预算、检索确定性）。
 * FTS5 路线注记：SQLite offsets() 已自当前版本移除，坐标检索走 MATCH+highlight 反推（本模块纯内存实现，不涉）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ChapterRef, CharacterEntry, KnowledgeEntry, Ledger, PropEntry, PromiseEntry } from './ledger.js'; // 仅类型——防运行时环（ledger.ts 预算闸反向引用本模块）
import { assertWorkDir, toPosix } from './fsutil.js';
import { normalizeName } from './character-norm.js'; // 运行时依赖无环（character-norm 对 ledger 仅 import type）
import { intervalActiveAt, ledgerToFacts, type FactEnvelope, type FactInterval } from './envelope.js';

/** 名字候选：主名+别名（别名归一 4.3 落地前，倒排键=条目内出现过的名字字段）。 */
export interface NameHit {
  type: FactEnvelope['type'];
  key: string;
  name: string;
  interval: FactInterval;
  /** 条目在账本数组中的下标（回取 payload 用）。 */
  index: number;
}

/** 索引（build 一次，slice/query 多次；账本变更后需重建——写穿闸门在 4.2 收件箱接入）。 */
export interface LedgerIndex {
  facts: FactEnvelope[];
  /** 名字键 → 候选（精确键；查询时主名+别名双查）。 */
  byName: Map<string, NameHit[]>;
  ledger: Ledger;
  chapterOrder: ChapterRef[];
}

/** 承重优先级（预算裁剪序；promise=伏笔线承重最高；character=4.3 信封原生首型，索引期不产出）。 */
const PRIORITY: Record<FactEnvelope['type'], number> = { promise: 0, prop: 1, knowledge: 2, clock: 3, character: 4 };

/** 类型预算配额（防单一类型独占——真账本实测第1137章 promise 1739 条会挤光其他维度；余量回收给缺型）。
 * 4.3 角色维入场：character 0.15（静态卡体积小、连续性承重高）；promise 0.4→0.35、prop/knowledge 0.25→0.2 让位。 */
const QUOTA: Record<FactEnvelope['type'], number> = { promise: 0.35, prop: 0.2, knowledge: 0.2, clock: 0.1, character: 0.15 };

/** 字符数预算（0905 裁决口径：切片 ≤3 万字符；JSON.stringify 计）。 */
export const DEFAULT_SLICE_BUDGET = 30_000;

/** 名字字段提取（倒排键来源；归一口径复用 character-norm 的 normalizeName——与预筛/引用解析同一套，防「·」类分叉）。 */
function namesOf(f: FactEnvelope): string[] {
  const norm = normalizeName;
  const out: string[] = [];
  if (f.type === 'prop') {
    const p = f.payload as PropEntry;
    if (p.name) out.push(p.name);
  } else if (f.type === 'promise') {
    const pr = f.payload as PromiseEntry;
    if (pr.name) out.push(pr.name);
    if (pr.id) out.push(pr.id);
  } else if (f.type === 'knowledge') {
    const k = f.payload as KnowledgeEntry;
    if (k.character) out.push(k.character);
  } else if (f.type === 'character') {
    // 4.3 角色维：主名+别名全入倒排（queryByName/预筛共用）
    const c = f.payload as CharacterEntry;
    if (c.name) out.push(c.name);
    for (const a of c.aliases ?? []) if (a) out.push(a);
  }
  return out.map(norm).filter(Boolean);
}

/** 从账本构建索引（order 查找表由 chapterOrderForWork 或调用方传入）。 */
export function buildLedgerIndex(ledger: Ledger, chapterOrder: ChapterRef[]): LedgerIndex {
  const facts = ledgerToFacts(ledger, chapterOrder);
  const byName = new Map<string, NameHit[]>();
  facts.forEach((f, index) => {
    for (const n of namesOf(f)) {
      const hits = byName.get(n) ?? [];
      hits.push({ type: f.type, key: f.key, name: n, interval: f.interval, index });
      byName.set(n, hits);
    }
  });
  return { facts, byName, ledger, chapterOrder };
}

/** 条目的注入渲染（紧凑单行 JSON——导生层不人审，字符效率优先）。 */
function renderFact(f: FactEnvelope): string {
  if (f.type === 'prop') {
    const p = f.payload as PropEntry;
    const last = p.custody.at(-1);
    return `[道具] ${p.name}｜持:${p.holder ?? '?'}｜态:${p.status ?? '?'}${p.tripwire ? `｜警:${p.tripwire}` : ''}${last?.quote ? `｜据:「${last.quote.slice(0, 40)}」` : ''}`;
  }
  if (f.type === 'promise') {
    const pr = f.payload as PromiseEntry;
    const setup = pr.setups[0];
    return `[伏笔] ${pr.name}｜态:${pr.arc}${pr.due ? `｜期:${pr.due}` : ''}${pr.expectedVolume ? `｜卷:${pr.expectedVolume}` : ''}${setup?.quote ? `｜据:「${setup.quote.slice(0, 40)}」` : ''}`;
  }
  if (f.type === 'knowledge') {
    const k = f.payload as KnowledgeEntry;
    const recent = k.knows.slice(-3);
    return `[知情] ${k.character}｜知:${recent.map((x) => x.fact.slice(0, 30)).join('；')}`;
  }
  if (f.type === 'character') {
    // 4.3 角色卡：静态档+最近动态状态（按 since 章序取尾 3——登记顺序≠生效顺序）
    const c = f.payload as CharacterEntry;
    const states = [...(c.states ?? [])].sort((a, b) => a.since.localeCompare(b.since)).slice(-3).map((s) => `${s.field}=${s.value}`).join('；');
    return `[角色] ${c.name}${c.kind && c.kind !== 'character' ? `(${c.kind})` : ''}${c.role ? `｜${c.role}` : ''}${c.faction ? `｜营:${c.faction}` : ''}${c.aliases?.length ? `｜别名:${c.aliases.join('/')}` : ''}${states ? `｜态:${states}` : ''}`;
  }
  // clock
  const c = f.payload as { chapters: string[]; storyDay?: string; thread?: string; notes?: string };
  return `[时间] ${c.storyDay ?? '?'}｜线:${c.thread ?? '?'}｜章:${c.chapters.length}`;
}

/** 按区间裁剪+预算裁剪的切片核心（纯函数，测试直接喂索引）。 */
export function indexedSliceFromIndex(index: LedgerIndex, order: number, budget = DEFAULT_SLICE_BUDGET): {
  lines: string[];
  chars: number;
  dropped: number;
  /** 注入构成（按类型计数），供「本次注入了什么」可见性。 */
  composition: Record<string, number>;
} {
  const active = index.facts
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => intervalActiveAt(f.interval, order));
  const lines: string[] = [];
  const composition: Record<string, number> = {};
  let chars = 0;
  let dropped = 0;
  // 两轮裁剪：先按类型配额装填（防独占），再按全局优先级回填余量
  const rendered = active
    .sort((a, b) => PRIORITY[a.f.type] - PRIORITY[b.f.type] || a.f.interval.from - b.f.interval.from)
    .map(({ f }) => ({ f, line: renderFact(f) }));
  const types = Object.keys(QUOTA) as FactEnvelope['type'][];
  for (const t of types) {
    let quota = budget * QUOTA[t];
    for (const r of rendered) {
      if (r.f.type !== t) continue;
      const cost = r.line.length + 1;
      if (quota - cost < 0) continue;
      lines.push(r.line);
      composition[t] = (composition[t] ?? 0) + 1;
      chars += cost;
      quota -= cost;
      r.line = ''; // 标记已用
    }
  }
  // 余量回填：未装填的按全局优先级
  for (const r of rendered) {
    if (r.line === '') continue;
    const cost = r.line.length + 1;
    if (chars + cost > budget) {
      dropped++;
      continue;
    }
    lines.push(r.line);
    composition[r.f.type] = (composition[r.f.type] ?? 0) + 1;
    chars += cost;
  }
  return { lines, chars, dropped, composition };
}

/** workDir 入口：构建索引 → 区间裁剪切片（章序表与账本由调用方传入——本模块只依赖类型不反引 ledger.ts）。 */
export function indexedSliceForWork(workDir: string, chapterRelPath: string, ledger: Ledger, chapterOrder: ChapterRef[], opts?: { budget?: number }): ReturnType<typeof indexedSliceFromIndex> {
  const wd = assertWorkDir(workDir);
  const orderTable = chapterOrder;
  const pos = orderTable.findIndex((c) => c.relPath === toPosix(chapterRelPath));
  if (pos < 0) throw new Error(`indexedSliceForWork：章不在章序表内: ${chapterRelPath}`);
  const order = Number(chapterRelPath.match(/(\d+)/)?.[1] ?? pos + 1);
  const index = buildLedgerIndex(ledger, orderTable);
  return indexedSliceFromIndex(index, order, opts?.budget);
}

/** 名字查询：主名/别名 → 命中条目（按区间过滤可选）。 */
export function queryByName(index: LedgerIndex, name: string, atOrder?: number): FactEnvelope[] {
  const norm = name.replace(/\s+/g, '').toLowerCase();
  const hits = index.byName.get(norm) ?? [];
  const out: FactEnvelope[] = [];
  for (const h of hits) {
    const f = index.facts[h.index];
    if (!f) continue;
    if (atOrder !== undefined && !intervalActiveAt(f.interval, atOrder)) continue;
    out.push(f);
  }
  return out;
}

/** 索引统计（QA/报告用）。 */
export function indexStats(index: LedgerIndex): { facts: number; nameKeys: number; openIntervals: number } {
  return {
    facts: index.facts.length,
    nameKeys: index.byName.size,
    openIntervals: index.facts.filter((f) => f.interval.to === null).length,
  };
}
