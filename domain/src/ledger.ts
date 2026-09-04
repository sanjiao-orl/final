/**
 * ledger.ts —— 四维账本（WS-9 结论 + T2 考古映射的 domain 落地）。
 *
 * 四维：时钟表 / 道具托管 / 承诺登记（=伏笔）/ 知情地图，结构 =「实体 + 状态字段 + 章节引用」。
 * 另含三张登记表：do-not-re-explain（不得重解释）、PROTECT（作者刻意设计，不报缺陷）、tripwire（高危硬规则）。
 * 另含问题日志（issues.md，CR 格式行文件）读写：issue_append 追加 / issue_set_status 改状态 / countBlockers 未处置 BLOCKER 计数（批三-1 闭环接通）。
 *
 * 存储形态：结构化 Markdown，账本机器态用 YAML frontmatter 承载（round-trip 安全），正文为人类可读渲染。
 * domain 工具读写该文件；默认路径 `.novel/ledger.md`（相对 workDir），可传 ledgerPath 覆盖。
 *
 * 纪律（来自 AGENTS.md + WS-9/T2 决策）：
 * - 账本重做，不搬旧代码；只参考 T2 考古报告规则描述 + WS-9 模板结构，本实现完全自研；
 * - 确定性诊断坚持「宁缺毋滥」：无把握自动判定的（如知情权跨章违规），不硬写，留作冷读人工维护项；
 * - 审阅输入组装禁止全量注入正文（ledgerSlice 只注入单章正文 + 账本切片）。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { atomicWrite, assertWorkDir, collectMdFiles, errText, resolveInside, sortMdFilesNumberAware, toPosix, type SkippedEntry } from './fsutil.js';
import { frontmatterEnd, parseFrontmatter } from './frontmatter.js';
import { loadPrompt } from './prompts.js';
import { SNAPSHOT_KEEP } from './tools.js';
import { indexedSliceForWork } from './ledger-index.js';

// ---------- 类型 ----------

/** 承诺/伏笔弧状态机（T2：planted/pending/resolved/failed）。 */
export type PromiseArc = 'planted' | 'pending' | 'resolved' | 'failed';
/** 承诺热度（WS-9：HOT/WARM/COLD）。 */
export type PromiseHeat = 'HOT' | 'WARM' | 'COLD';

/** 时钟表一行 = 一个时间跨度（T2 timeline → 账本时钟表，保持规则式，不做完整时间轴推理）。 */
export interface ClockRow {
  /** 章节引用（可多章归入同一跨度）。 */
  chapters: string[];
  /** 故事线（主线/支线等）。 */
  thread?: string;
  /** 故事日（如 第1日 / 第1日:晨）。 */
  storyDay?: string;
  /** 季节锚定（如 未锚定 / 初春 / 盛夏）。 */
  season?: string;
  /** 绝对历法日期（公历，可选；calendar 命中时锚定）。 */
  absoluteDate?: string;
  notes?: string;
}

/** 道具托管链的一步（谁在何时持有）。 */
export interface CustodyStep {
  /** 章节引用。 */
  chapter: string;
  /** 章内 1 起始行号（可选）。 */
  line?: number;
  /** 持有者。 */
  holder?: string;
  /** 原文引用，可截断，供证据（决策 0013 证据锚统一 schema）。 */
  quote?: string;
  note?: string;
}

/** 道具托管：一个道具实体 + 托管链。 */
export interface PropEntry {
  name: string;
  /** 道具类别（主线道具/容器/普通钱/信物…）。 */
  type?: string;
  /** 当前持有者。 */
  holder?: string;
  /** 当前状态描述。 */
  status?: string;
  /** 托管链（按时间序）。 */
  custody: CustodyStep[];
  /** 硬规则（如「不得出现第二枚」「不得被当普通钱花掉」）。 */
  tripwire?: string;
}

/** 承诺登记：伏笔埋设点。 */
export interface PromiseSetup {
  chapter: string;
  line?: number;
  /** 原文引用（可截断，供证据）。 */
  quote?: string;
}

/** 承诺登记：伏笔回收点。 */
export interface PromisePayoff {
  chapter: string;
  line?: number;
  /** 原文引用，可截断，供证据（决策 0013 证据锚统一 schema）。 */
  quote?: string;
}

/** 承诺登记：一个伏笔/承诺实体。 */
export interface PromiseEntry {
  id: string;
  name: string;
  arc: PromiseArc;
  heat?: PromiseHeat;
  setups: PromiseSetup[];
  payoffs: PromisePayoff[];
  /** 逾期维度（T2 新增）：埋设后 N 章内未回收 → 诊断提示。缺省不设（不强制）。 */
  due?: number;
  note?: string;
  /** 预计回收卷（卷级作用域，批三-2）：如「卷一」；自由字符串，缺省不设。 */
  expectedVolume?: string;
  /** 跨维引用（批三-2）：关联道具名/角色名；缺省不设。 */
  links?: { props?: string[]; characters?: string[] };
}

/** 知情事实（批三-2 时间轴化）：fact=事实描述；since=得知章的 manuscript relPath（正斜杠）；refs=回指的伏笔 id 列表。 */
export interface KnowledgeFact {
  fact: string;
  /** 得知章（manuscript relPath），供时间轴排序与「自 <章>」后缀；缺省表示无时间锚。 */
  since?: string;
  /** 回指的伏笔 id 列表（如 F-001）。 */
  refs?: string[];
  /** 原文引用，可截断，供证据（决策 0013 证据锚统一 schema）。 */
  quote?: string;
}

/** 知情地图：一个角色的知情范围（T2 knowledge 轴 public/selective/secret）。 */
export interface KnowledgeEntry {
  character: string;
  /** 已知事实（事实描述；parse/assert 双路径统一升级为 KnowledgeFact，元素兼容纯字符串旧格式）。 */
  knows: KnowledgeFact[];
  /** 明确未知（作者登记，用于戏剧反讽判定；与 knows 同构）。 */
  doesNotKnow?: KnowledgeFact[];
  /** 可见性：public（默认）/ selective / secret（保密铁律）。 */
  visibility?: 'public' | 'selective' | 'secret';
  /** selective/secret 时必填的知情人。 */
  knownBy?: string[];
}

/** PROTECT 登记项：作者刻意设计，审阅不得报缺陷。 */
export interface ProtectEntry {
  item: string;
  reason?: string;
}

/** 四维账本 + 三张登记表。 */
export interface Ledger {
  clock: ClockRow[];
  props: PropEntry[];
  promises: PromiseEntry[];
  knowledge: KnowledgeEntry[];
  doNotReexplain: string[];
  protect: ProtectEntry[];
  tripwires: string[];
  /** 未知 frontmatter 字段（人工增补/未来新字段）：parse 时原样透传保留，serialize 时写回；不解析不校验。 */
  extra?: Record<string, unknown>;
}

/** 章节顺序（用于「逾期」章距计算与渲染时间轴化排序；顺序即结构树阅读顺序）。 */
export type ChapterRef = { relPath: string; title: string };

/** 空账本。 */
export function emptyLedger(): Ledger {
  return { clock: [], props: [], promises: [], knowledge: [], doNotReexplain: [], protect: [], tripwires: [] };
}

// ---------- 账本操作（纯函数，可独立测试） ----------

/** 单个操作。op 决定操作维度：upsert（clock/prop/promise/knowledge/三张登记表）与 remove（按各维自然键删除）。语义见 applyOps。 */
export type LedgerOp =
  | { op: 'clock'; entry: ClockRow }
  | { op: 'prop'; entry: PropEntry }
  | { op: 'promise'; entry: PromiseEntry }
  | { op: 'knowledge'; entry: KnowledgeEntry }
  | { op: 'doNotReexplain'; fact: string }
  | { op: 'protect'; item: string; reason?: string }
  | { op: 'tripwire'; item: string }
  /** remove：按各维自然键删除一条匹配条目（键语义与 upsert 判重键一致）；找不到目标静默 no-op（幂等）。 */
  | { op: 'remove'; dimension: 'clock'; chapters: string[] }
  | { op: 'remove'; dimension: 'prop'; name: string }
  | { op: 'remove'; dimension: 'promise'; id: string }
  | { op: 'remove'; dimension: 'knowledge'; character: string }
  | { op: 'remove'; dimension: 'doNotReexplain' | 'protect' | 'tripwire'; item: string };

/** 数组判等（顺序无关的字符串集合相等）。 */
function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

/**
 * applyOps：把一组操作应用到账本（纯函数，返回新对象）。
 * - clock：按 chapters 键 upsert（同名章节跨度替换，否则追加）；
 * - prop/promise/knowledge：按 name/id/character 键 upsert；
 * - doNotReexplain/tripwire：字符串去重追加；protect：按 item 去重追加；
 * - remove：按各维自然键删除匹配条目（键语义与 upsert 判重键一致：clock 按 chapters 集合、
 *   prop 按 name、promise 按 id、knowledge 按 character、三张登记表按文本精确匹配）；
 *   找不到目标时静默 no-op（幂等，与登记表去重追加风格一致），不报错；
 * - 校验失败统一抛「ledger_upsert 的 ops 不合法: …」（对齐 tools.ts 守卫中文风格）。
 */
export function applyOps(ledger: Ledger, ops: LedgerOp[]): Ledger {
  const out: Ledger = {
    clock: [...ledger.clock],
    props: [...ledger.props],
    promises: [...ledger.promises],
    knowledge: [...ledger.knowledge],
    doNotReexplain: [...ledger.doNotReexplain],
    protect: [...ledger.protect],
    tripwires: [...ledger.tripwires],
    ...(ledger.extra ? { extra: ledger.extra } : {}), // 未知字段透传：读改写不丢
  };
  try {
    if (!Array.isArray(ops)) throw new Error('ops 必须是数组');
    for (const raw of ops) {
      const op = raw as { op?: unknown };
      if (typeof op.op !== 'string') throw new Error(`ledger 操作缺 op: ${JSON.stringify(raw)}`);
      switch (op.op) {
        case 'clock': {
          const entry = (raw as { entry: ClockRow }).entry;
          assertClockRow(entry);
          const i = out.clock.findIndex((r) => sameStringArray(r.chapters, entry.chapters));
          if (i >= 0) out.clock[i] = entry;
          else out.clock.push(entry);
          break;
        }
        case 'prop': {
          const entry = (raw as { entry: PropEntry }).entry;
          assertProp(entry);
          const i = out.props.findIndex((p) => p.name === entry.name);
          if (i >= 0) out.props[i] = entry;
          else out.props.push(entry);
          break;
        }
        case 'promise': {
          const entry = (raw as { entry: PromiseEntry }).entry;
          assertPromise(entry);
          const i = out.promises.findIndex((p) => p.id === entry.id);
          if (i >= 0) out.promises[i] = entry;
          else out.promises.push(entry);
          break;
        }
        case 'knowledge': {
          const entry = (raw as { entry: KnowledgeEntry }).entry;
          assertKnowledge(entry);
          const i = out.knowledge.findIndex((k) => k.character === entry.character);
          if (i >= 0) out.knowledge[i] = entry;
          else out.knowledge.push(entry);
          break;
        }
        case 'doNotReexplain': {
          const fact = (raw as { fact: unknown }).fact;
          if (typeof fact !== 'string' || fact.trim() === '') throw new Error('doNotReexplain 需要非空 fact');
          if (!out.doNotReexplain.includes(fact)) out.doNotReexplain.push(fact);
          break;
        }
        case 'protect': {
          const item = (raw as { item: unknown }).item;
          const reason = (raw as { reason?: unknown }).reason;
          if (typeof item !== 'string' || item.trim() === '') throw new Error('protect 需要非空 item');
          if (!out.protect.some((p) => p.item === item)) {
            out.protect.push({ item, ...(typeof reason === 'string' && reason.trim() !== '' ? { reason } : {}) });
          }
          break;
        }
        case 'tripwire': {
          const item = (raw as { item: unknown }).item;
          if (typeof item !== 'string' || item.trim() === '') throw new Error('tripwire 需要非空 item');
          if (!out.tripwires.includes(item)) out.tripwires.push(item);
          break;
        }
        case 'remove': {
          const d = (raw as { dimension?: unknown }).dimension;
          if (typeof d !== 'string') throw new Error('remove 缺少 dimension');
          switch (d) {
            case 'clock': {
              const chapters = (raw as { chapters?: unknown }).chapters;
              if (!Array.isArray(chapters) || chapters.length === 0 || !chapters.every((c) => typeof c === 'string')) {
                throw new Error('remove clock 需要非空 chapters 字符串数组');
              }
              const keys = chapters as string[];
              out.clock = out.clock.filter((r) => !sameStringArray(r.chapters, keys));
              break;
            }
            case 'prop': {
              const name = (raw as { name?: unknown }).name;
              if (typeof name !== 'string' || name.trim() === '') throw new Error('remove prop 需要非空 name');
              out.props = out.props.filter((p) => p.name !== name);
              break;
            }
            case 'promise': {
              const id = (raw as { id?: unknown }).id;
              if (typeof id !== 'string' || id.trim() === '') throw new Error('remove promise 需要非空 id');
              out.promises = out.promises.filter((p) => p.id !== id);
              break;
            }
            case 'knowledge': {
              const character = (raw as { character?: unknown }).character;
              if (typeof character !== 'string' || character.trim() === '') throw new Error('remove knowledge 需要非空 character');
              out.knowledge = out.knowledge.filter((k) => k.character !== character);
              break;
            }
            case 'doNotReexplain': {
              const item = (raw as { item?: unknown }).item;
              if (typeof item !== 'string' || item.trim() === '') throw new Error('remove doNotReexplain 需要非空 item');
              out.doNotReexplain = out.doNotReexplain.filter((x) => x !== item);
              break;
            }
            case 'protect': {
              const item = (raw as { item?: unknown }).item;
              if (typeof item !== 'string' || item.trim() === '') throw new Error('remove protect 需要非空 item');
              out.protect = out.protect.filter((p) => p.item !== item);
              break;
            }
            case 'tripwire': {
              const item = (raw as { item?: unknown }).item;
              if (typeof item !== 'string' || item.trim() === '') throw new Error('remove tripwire 需要非空 item');
              out.tripwires = out.tripwires.filter((x) => x !== item);
              break;
            }
            default:
              throw new Error(`未知 remove 维度: ${String(d)}`);
          }
          break;
        }
        default:
          throw new Error(`未知 ledger 操作: ${String(op.op)}`);
      }
    }
  } catch (err) {
    // 校验错误统一包装成 tools.ts 守卫风格（如「ledger_upsert 的 ops 不合法: …」）
    throw new Error(`ledger_upsert 的 ops 不合法: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

// ---------- 按章过滤账本（纯函数，可独立测试） ----------

/**
 * filterLedgerForChapter：按当前章把账本裁成「截至本章已知」的视角（冷读注入用，只读视图）。
 * 语义（批三-3）：
 * - relPath 不在 chapterOrder 内 → 返回 null；idx = 当前章在 chapterOrder 的下标，某章 c 的序号 idxOf(c) 不在序内视为「未知」；
 * - clock：保留行内任一章未知或 idxOf≤idx 的行（整段跨度都在未来才删——跨多章的时间状态在当前章仍活着，不能丢）；
 * - props：每条托管链裁到只留 chapter 未知或 ≤idx 的链节；裁后链空 → 整条 prop 删除；
 * - promises：保留 iff (无 setups 或至少一个 setups 章未知或 ≤idx) 且 (无 payoffs 或至少一个 payoffs 章未知或 ≥idx)；
 *   全部 setups 在未来=尚未开埋（规划信息）删；全部 payoffs 在过去=已回收完（噪音）删；
 *   多节伏笔（setups[ch2,ch8]/payoffs[ch3,ch9]）只埋了几节/只收了几节仍存活——drop iff 全在过去，防漏回收；
 * - knowledge：knows/doesNotKnow 的每条事实保留 iff 无 since 或 since 章未知或 idxOf(since)≤idx；refs 原样透传；
 * - 其余各节（doNotReexplain/protect/tripwires/extra）原样透传。
 * 不 mutate 入参（逐维重建，风格同 applyOps）。
 */
export function filterLedgerForChapter(ledger: Ledger, chapterOrder: ChapterRef[], relPath: string): Ledger | null {
  const idx = chapterOrder.findIndex((c) => c.relPath === relPath);
  if (idx === -1) return null;
  const orderIndex = new Map(chapterOrder.map((c, i) => [c.relPath, i]));
  const idxOf = (ref: string): number | undefined => orderIndex.get(ref);
  /** 章引用在「当前章或之前」或未知（无法定位按保留处理，不泄露确定未来）。 */
  const atOrBefore = (ref: string): boolean => {
    const i = idxOf(ref);
    return i === undefined || i <= idx;
  };

  const clock = ledger.clock.filter((r) => r.chapters.some((c) => atOrBefore(c)));
  const props = ledger.props
    .map((p) => ({ ...p, custody: p.custody.filter((s) => atOrBefore(s.chapter)) }))
    .filter((p) => p.custody.length > 0);
  const promises = ledger.promises.filter((p) => {
    // 仍未开埋（全部埋设点都在未来）才删；埋过至少一次即存活。
    const plantedOk = p.setups.length === 0 || p.setups.some((s) => atOrBefore(s.chapter));
    // 已回收完（全部回收点都在过去）才删；多节伏笔只回收了前几节仍存活。
    const resolutionOk =
      p.payoffs.length === 0 ||
      p.payoffs.some((x) => {
        const i = idxOf(x.chapter);
        return i === undefined || i >= idx;
      });
    return plantedOk && resolutionOk;
  });
  const filterFacts = (facts: KnowledgeFact[]): KnowledgeFact[] =>
    facts.filter((f) => f.since === undefined || atOrBefore(f.since));
  const knowledge = ledger.knowledge.map((k) => ({
    ...k,
    knows: filterFacts(k.knows),
    ...(k.doesNotKnow !== undefined ? { doesNotKnow: filterFacts(k.doesNotKnow) } : {}),
  }));

  return {
    clock,
    props,
    promises,
    knowledge,
    doNotReexplain: [...ledger.doNotReexplain],
    protect: [...ledger.protect],
    tripwires: [...ledger.tripwires],
    ...(ledger.extra ? { extra: ledger.extra } : {}),
  };
}

function assertClockRow(entry: unknown): asserts entry is ClockRow {
  const e = entry as ClockRow;
  if (!e || !Array.isArray(e.chapters) || e.chapters.length === 0) {
    throw new Error('clock 需要非空 chapters 数组');
  }
  if (!e.chapters.every((c) => typeof c === 'string')) {
    throw new Error('clock.chapters 必须是字符串数组');
  }
}
function assertProp(entry: unknown): asserts entry is PropEntry {
  const e = entry as PropEntry;
  if (!e || typeof e.name !== 'string' || e.name.trim() === '') throw new Error('prop 需要非空 name');
  if (!Array.isArray(e.custody)) throw new Error('prop.custody 必须是数组');
}
function assertPromise(entry: unknown): asserts entry is PromiseEntry {
  const e = entry as PromiseEntry;
  if (!e || typeof e.id !== 'string' || e.id.trim() === '') throw new Error('promise 需要非空 id');
  if (typeof e.name !== 'string' || e.name.trim() === '') throw new Error(`promise「${e.id}」需要非空 name(伏笔名)`);
  // arc 缺省(缺字段/空串)按新埋设 planted——与 normalizeLedger 读路径口径一致;非空非法值报允许枚举,便于定位
  if (e.arc === undefined || e.arc === null || (e.arc as unknown) === '') e.arc = 'planted';
  if (!['planted', 'pending', 'resolved', 'failed'].includes(e.arc)) {
    throw new Error(`promise「${e.id}」非法 arc: ${String(e.arc)}(允许: planted 埋设/pending 待回收/resolved 已回收/failed 断线)`);
  }
  if (!Array.isArray(e.setups)) throw new Error(`promise「${e.id}」setups 必须是数组(可空)`);
  if (!Array.isArray(e.payoffs)) throw new Error(`promise「${e.id}」payoffs 必须是数组(可空)`);
}
function assertKnowledge(entry: unknown): asserts entry is KnowledgeEntry {
  const e = entry as KnowledgeEntry;
  if (!e || typeof e.character !== 'string' || e.character.trim() === '') throw new Error('knowledge 需要非空 character');
  if (!Array.isArray(e.knows)) throw new Error('knowledge.knows 必须是数组');
  // 批三-2 放宽：元素允许字符串（原地升级为 {fact}）或对象（需 fact 非空字符串）——与 normalizeLedger 读路径口径一致
  const upgrade = (item: unknown): KnowledgeFact => {
    if (typeof item === 'string') {
      const t = item.trim();
      if (t === '') throw new Error('knowledge 元素不能为空字符串');
      return { fact: t };
    }
    const o = item as Partial<KnowledgeFact>;
    if (!o || typeof o.fact !== 'string' || o.fact.trim() === '') {
      throw new Error('knowledge 元素必须是非空字符串或带非空 fact 的对象');
    }
    const kf: KnowledgeFact = { fact: o.fact.trim() };
    if (typeof o.since === 'string' && o.since.trim() !== '') kf.since = o.since.trim();
    if (typeof o.quote === 'string' && o.quote.trim() !== '') kf.quote = o.quote.trim();
    if (Array.isArray(o.refs)) {
      const refs = o.refs.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map((r) => r.trim());
      if (refs.length > 0) kf.refs = refs;
    }
    return kf;
  };
  e.knows = (e.knows as unknown as Array<string | KnowledgeFact>).map((k) => upgrade(k));
  if (e.doesNotKnow !== undefined) {
    if (!Array.isArray(e.doesNotKnow)) throw new Error('knowledge.doesNotKnow 必须是数组');
    e.doesNotKnow = (e.doesNotKnow as unknown as Array<string | KnowledgeFact>).map((k) => upgrade(k));
  }
}

// ---------- 序列化：YAML frontmatter（机器态）+ Markdown 渲染（人读） ----------

/** 账本默认文件路径（相对 workDir）。 */
export const DEFAULT_LEDGER_PATH = '.novel/ledger.md';

/** 卷提取：章 relPath `manuscript/<卷>/<章>.md` 段数 ≥3 时卷 = 第二段，否则 null（未分卷）。 */
function chapterVolume(rel: string): string | null {
  const parts = rel.split('/');
  return parts.length >= 3 ? parts[1] ?? null : null;
}

/** 渲染时钟表为 Markdown 表格（chapterOrder 提供时按「行内首个可定位章」的章序排序，查不到的保持原相对序在后）。 */
function renderClock(clock: ClockRow[], chapterOrder?: ChapterRef[]): string {
  if (clock.length === 0) return '_（空）_';
  const head = ['| Chapters | Thread | Story-day | Season | Absolute date | Notes |', '| --- | --- | --- | --- | --- | --- |'];
  const esc = (s: string | undefined): string => (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const orderIndex = chapterOrder ? new Map(chapterOrder.map((c, i) => [c.relPath, i])) : undefined;
  const rows = clock.map((r) => {
    let idx: number | undefined;
    if (orderIndex) {
      for (const c of r.chapters) {
        const i = orderIndex.get(c);
        if (i !== undefined) {
          idx = i;
          break;
        }
      }
    }
    return { r, idx };
  });
  if (orderIndex && orderIndex.size > 0) {
    rows.sort((a, b) => {
      if (a.idx !== undefined && b.idx !== undefined) return a.idx - b.idx;
      if (a.idx !== undefined) return -1; // 可定位在前
      if (b.idx !== undefined) return 1;
      return 0; // 都不可定位：保持原相对序（稳定排序）
    });
  }
  const body = rows.map(
    ({ r }) =>
      `| ${r.chapters.map(esc).join(', ') || '-'} | ${esc(r.thread)} | ${esc(r.storyDay)} | ${esc(r.season)} | ${esc(r.absoluteDate)} | ${esc(r.notes)} |`,
  );
  return [head[0], head[1], ...body].join('\n');
}

/**
 * 渲染承诺登记（批三-2 分层聚合）：
 * - 未回收（planted/pending）按「最后一个 setup 章的卷」分组，小节 `### <卷名> · 未回收`；无卷归 `### 未分卷 · 未回收`；
 * - resolved/failed 全部沉底进 `### 已回收 / 断线` 一个小节（不分卷）；
 * - 未回收组内排序：HOT 最前，其次 WARM/COLD/无热度；同热度保持原顺序；
 * - 行内标记（在原有基础上扩充）：〔悬空〕=setups>0 且 payoffs=0；〔逾期·已过 N 章〕=chapterOrder 提供且
 *   与 ledgerDiagnostics overdue-promise 口径一致（planted/pending + 无回收 + 已过 ≥ due 章）；〔预计回收卷 X 已过〕=
 *   设了 expectedVolume 且未回收且 chapterOrder 末章的卷 ≠ expectedVolume；links 内联 `（道具: A、B · 角色: C）`（缺省不出）。
 */
function renderPromises(promises: PromiseEntry[], chapterOrder?: ChapterRef[]): string {
  if (promises.length === 0) return '_（空）_';
  const orderIndex = chapterOrder ? new Map(chapterOrder.map((c, i) => [c.relPath, i])) : undefined;
  const total = chapterOrder?.length ?? 0;
  const lastVol = chapterOrder && chapterOrder.length > 0 ? chapterVolume(chapterOrder[chapterOrder.length - 1]!.relPath) : null;
  const volumeOf = (p: PromiseEntry): string | null => {
    const lastSetup = p.setups.length > 0 ? p.setups[p.setups.length - 1]!.chapter : null;
    return lastSetup !== null ? chapterVolume(lastSetup) : null;
  };

  const renderLinks = (p: PromiseEntry): string => {
    const l = p.links;
    if (!l) return '';
    const props = l.props && l.props.length > 0 ? `道具: ${l.props.join('、')}` : '';
    const chars = l.characters && l.characters.length > 0 ? `角色: ${l.characters.join('、')}` : '';
    const inner = [props, chars].filter(Boolean).join(' · ');
    return inner !== '' ? `（${inner}）` : '';
  };

  const renderOne = (p: PromiseEntry): string => {
    const heat = p.heat ? `·${p.heat}` : '';
    const setups = p.setups.length > 0 ? p.setups.map((s) => `${s.chapter}${s.line ? `:${s.line}` : ''}`).join(', ') : '无';
    const payoffs = p.payoffs.length > 0 ? p.payoffs.map((x) => `${x.chapter}${x.line ? `:${x.line}` : ''}`).join(', ') : '无';
    const due = p.due !== undefined ? `，逾期：${p.due} 章` : '';
    let markers = '';
    // 悬空：未回收弧（planted/pending）埋设了但无回收（与 dangling-promise 诊断同口径；纯派生标记，不依赖 chapterOrder）
    if ((p.arc === 'planted' || p.arc === 'pending') && p.setups.length > 0 && p.payoffs.length === 0) markers += '〔悬空〕';
    // 逾期：仅当 chapterOrder 提供；判定口径与 ledgerDiagnostics overdue-promise 一致
    if (
      chapterOrder !== undefined &&
      p.due !== undefined &&
      p.due >= 0 &&
      (p.arc === 'planted' || p.arc === 'pending') &&
      p.payoffs.length === 0 &&
      p.setups.length > 0
    ) {
      const lastSetup = p.setups[p.setups.length - 1]!.chapter;
      const lastIdx = orderIndex?.get(lastSetup);
      if (lastIdx !== undefined && total - 1 - lastIdx >= p.due) {
        markers += `〔逾期·已过 ${total - 1 - lastIdx} 章〕`;
      }
    }
    // 预计回收卷已过：设了 expectedVolume 且未回收且 chapterOrder 末章的卷 ≠ expectedVolume（末章无卷则不算已过）
    if (
      chapterOrder !== undefined &&
      p.expectedVolume !== undefined &&
      (p.arc === 'planted' || p.arc === 'pending') &&
      lastVol !== null &&
      lastVol !== p.expectedVolume
    ) {
      markers += `〔预计回收卷 ${p.expectedVolume} 已过〕`;
    }
    return `- **${p.id}** [${p.arc}${heat}] ${p.name} — 埋设：${setups}；回收：${payoffs}${due}${markers}${renderLinks(p)}${p.note ? `（${p.note}）` : ''}`;
  };

  const heatRank = (p: PromiseEntry): number => (p.heat === 'HOT' ? 0 : p.heat === 'WARM' ? 1 : p.heat === 'COLD' ? 2 : 3);
  const open = promises.filter((p) => p.arc === 'planted' || p.arc === 'pending');
  const closed = promises.filter((p) => p.arc === 'resolved' || p.arc === 'failed');
  // 未回收按卷分组（保持卷首见顺序）；无卷归 null（渲染为「未分卷」）
  const byVolume = new Map<string | null, PromiseEntry[]>();
  for (const p of open) {
    const v = volumeOf(p);
    const list = byVolume.get(v) ?? [];
    list.push(p);
    byVolume.set(v, list);
  }
  const blocks: string[] = [];
  for (const [v, list] of byVolume) {
    const sorted = [...list].sort((a, b) => {
      const ra = heatRank(a);
      const rb = heatRank(b);
      if (ra !== rb) return ra - rb;
      return 0; // 同热度保持原顺序（稳定排序）
    });
    blocks.push([`### ${v ?? '未分卷'} · 未回收`, ...sorted.map(renderOne)].join('\n'));
  }
  if (closed.length > 0) {
    blocks.push(['### 已回收 / 断线', ...closed.map(renderOne)].join('\n'));
  }
  return blocks.join('\n\n');
}

/** 渲染道具托管（chapterOrder 提供时托管链步骤按章序排，查不到的保持原相对序在后；行格式其余不变）。 */
function renderProps(props: PropEntry[], chapterOrder?: ChapterRef[]): string {
  if (props.length === 0) return '_（空）_';
  const orderIndex = chapterOrder ? new Map(chapterOrder.map((c, i) => [c.relPath, i])) : undefined;
  return props
    .map((p) => {
      let steps = p.custody;
      if (orderIndex && orderIndex.size > 0) {
        steps = [...p.custody].sort((a, b) => {
          const ia = orderIndex.get(a.chapter);
          const ib = orderIndex.get(b.chapter);
          if (ia !== undefined && ib !== undefined) return ia - ib;
          if (ia !== undefined) return -1;
          if (ib !== undefined) return 1;
          return 0;
        });
      }
      const chain = steps.length > 0 ? steps.map((c) => `${c.holder ?? '?'}(${c.chapter}${c.line ? `:${c.line}` : ''})`).join(' → ') : '（无托管链）';
      return `- **${p.name}**${p.type ? ` [${p.type}]` : ''} — 当前：${p.holder ?? '?'}${p.status ? `（${p.status}）` : ''}；托管链：${chain}${p.tripwire ? `；硬规则：${p.tripwire}` : ''}`;
    })
    .join('\n');
}

/**
 * 渲染知情地图（批三-2 时间轴化）：
 * - since 提供时事实渲染为 `fact（自 <章标题>）`（章标题经 chapterOrder 查，查不到直接用 relPath 文本）；refs 渲染为 `（伏笔: F-001、F-002）`；
 * - chapterOrder 提供时 knows/doesNotKnow 内的 facts 按 since 章序排（无 since 的排最后，保持原相对序）；
 * - 行首 visibility/knownBy 标注保持现状口径。
 */
function renderKnowledge(knowledge: KnowledgeEntry[], chapterOrder?: ChapterRef[]): string {
  if (knowledge.length === 0) return '_（空）_';
  const orderIndex = chapterOrder ? new Map(chapterOrder.map((c, i) => [c.relPath, i])) : undefined;
  const titleOf = (rel: string): string =>
    chapterOrder?.find((c) => c.relPath === rel)?.title ?? rel.split('/').pop()?.replace(/\.md$/i, '') ?? rel;
  const sortFacts = (facts: KnowledgeFact[]): KnowledgeFact[] => {
    if (!orderIndex || orderIndex.size === 0) return facts;
    return [...facts].sort((a, b) => {
      const ia = a.since !== undefined ? orderIndex.get(a.since) : undefined;
      const ib = b.since !== undefined ? orderIndex.get(b.since) : undefined;
      if (ia !== undefined && ib !== undefined) return ia - ib;
      if (ia !== undefined) return -1; // 有 since 且可定位在前
      if (ib !== undefined) return 1;
      return 0; // 无 since 或不可定位：保持原相对序（稳定排序）
    });
  };
  const renderFacts = (facts: KnowledgeFact[]): string =>
    facts
      .map((f) => {
        let t = f.fact;
        if (f.since !== undefined) t += `（自 ${titleOf(f.since)}）`;
        if (f.refs && f.refs.length > 0) t += `（伏笔: ${f.refs.join('、')}）`;
        return t;
      })
      .join('；');
  return knowledge
    .map((k) => {
      const vis = k.visibility && k.visibility !== 'public' ? ` [${k.visibility}${k.knownBy ? `: ${k.knownBy.join(',')}` : ''}]` : '';
      const knows = k.knows.length > 0 ? renderFacts(sortFacts(k.knows)) : '（无）';
      const dnk = k.doesNotKnow && k.doesNotKnow.length > 0 ? `；不知道：${renderFacts(sortFacts(k.doesNotKnow))}` : '';
      return `- **${k.character}**${vis} 知道：${knows}${dnk}`;
    })
    .join('\n');
}

/**
 * 渲染整个账本为人类可读 Markdown（正文部分；frontmatter 由 writeLedger 单独写）。
 * opts.chapterOrder 缺省时所有「章序排序/逾期标记」降级为不排序不标记，其余照常。
 */
export function renderLedgerMarkdown(ledger: Ledger, opts?: { chapterOrder?: ChapterRef[] }): string {
  const chapterOrder = opts?.chapterOrder;
  return [
    '# Reader Ledger',
    '',
    '> 四维账本（时钟表 / 道具托管 / 承诺登记 / 知情地图）+ 三张登记表。',
    '> 本文件由 domain 账本工具读写；机器态在顶部 YAML frontmatter，正文为渲染视图。',
    '> ⚠ 正文为机器渲染视图，手工增补将在下次写入时被覆盖——要改请用 ledger_upsert 工具或直接改 YAML frontmatter。',
    '',
    '## Position / Clock table',
    '',
    renderClock(ledger.clock, chapterOrder),
    '',
    '## Promise register',
    '',
    renderPromises(ledger.promises, chapterOrder),
    '',
    '## Prop custody',
    '',
    renderProps(ledger.props, chapterOrder),
    '',
    '## Character knowledge-map',
    '',
    renderKnowledge(ledger.knowledge, chapterOrder),
    '',
    '## Do-not-re-explain register',
    '',
    ledger.doNotReexplain.length > 0 ? ledger.doNotReexplain.map((x) => `- ${x}`).join('\n') : '_（空）_',
    '',
    '## PROTECT',
    '',
    ledger.protect.length > 0 ? ledger.protect.map((p) => `- ${p.item}${p.reason ? ` — ${p.reason}` : ''}`).join('\n') : '_（空）_',
    '',
    '## High-risk tripwires',
    '',
    ledger.tripwires.length > 0 ? ledger.tripwires.map((x) => `- ${x}`).join('\n') : '_（空）_',
    '',
  ].join('\n') + '\n';
}

/** 账本 frontmatter 的已知键；其余键视为未知字段（人工增补/未来新字段）透传保留。 */
const LEDGER_KNOWN_KEYS = ['clock', 'props', 'promises', 'knowledge', 'doNotReexplain', 'protect', 'tripwires'];

/**
 * 解析 knowledge 的 knows/doesNotKnow 数组（批三-2 向后兼容）：
 * - 纯字符串项（旧格式）容错升级为 { fact: <字符串> }；
 * - 对象项按新结构解析：fact 非空字符串才收（否则丢弃该项），since/refs 容错；
 * - 其他类型（数字/布尔/null）丢弃。
 */
function knowledgeFacts(v: unknown): KnowledgeFact[] {
  if (!Array.isArray(v)) return [];
  const out: KnowledgeFact[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      const t = item.trim();
      if (t !== '') out.push({ fact: t });
      continue;
    }
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const o = item as Record<string, unknown>;
      const fact = typeof o.fact === 'string' && o.fact.trim() !== '' ? o.fact.trim() : undefined;
      if (fact === undefined) continue; // fact 非空字符串才收
      const kf: KnowledgeFact = { fact };
      const since = typeof o.since === 'string' && o.since.trim() !== '' ? o.since.trim() : undefined;
      if (since !== undefined) kf.since = since;
      const refs = Array.isArray(o.refs)
        ? o.refs.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map((r) => r.trim())
        : undefined;
      if (refs !== undefined && refs.length > 0) kf.refs = refs;
      const quote = typeof o.quote === 'string' && o.quote.trim() !== '' ? o.quote.trim() : undefined;
      if (quote !== undefined) kf.quote = quote;
      out.push(kf);
    }
  }
  return out;
}

/** 把解析出的 YAML 原始对象规范化为 Ledger（容错：缺失字段补默认值）。 */
function normalizeLedger(raw: unknown): Ledger {
  const base = emptyLedger();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;
  // 未知字段透传：非已知键原样保留（不解析不校验，仅透传），serialize 时写回；与已知字段冲突时已知字段优先
  const extra: Record<string, unknown> = {};
  for (const k of Object.keys(r)) {
    if (!LEDGER_KNOWN_KEYS.includes(k)) extra[k] = r[k];
  }
  if (Object.keys(extra).length > 0) base.extra = extra;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

  base.clock = arr(r.clock).map((c): ClockRow => {
    const o = (c ?? {}) as Record<string, unknown>;
    const row: ClockRow = { chapters: strArr(o.chapters) };
    const thread = str(o.thread);
    if (thread !== undefined) row.thread = thread;
    const storyDay = str(o.storyDay);
    if (storyDay !== undefined) row.storyDay = storyDay;
    const season = str(o.season);
    if (season !== undefined) row.season = season;
    const absoluteDate = str(o.absoluteDate);
    if (absoluteDate !== undefined) row.absoluteDate = absoluteDate;
    const notes = str(o.notes);
    if (notes !== undefined) row.notes = notes;
    return row;
  });
  base.props = arr(r.props).map((p): PropEntry => {
    const o = (p ?? {}) as Record<string, unknown>;
    const prop: PropEntry = {
      name: str(o.name) ?? '',
      custody: arr(o.custody).map((s) => {
        const so = (s ?? {}) as Record<string, unknown>;
        const step: CustodyStep = { chapter: str(so.chapter) ?? '' };
        const line = num(so.line);
        if (line !== undefined) step.line = line;
        const holder = str(so.holder);
        if (holder !== undefined) step.holder = holder;
        const quote = str(so.quote);
        if (quote !== undefined) step.quote = quote;
        const note = str(so.note);
        if (note !== undefined) step.note = note;
        return step;
      }),
    };
    const type = str(o.type);
    if (type !== undefined) prop.type = type;
    const holder = str(o.holder);
    if (holder !== undefined) prop.holder = holder;
    const status = str(o.status);
    if (status !== undefined) prop.status = status;
    const tripwire = str(o.tripwire);
    if (tripwire !== undefined) prop.tripwire = tripwire;
    return prop;
  });
  base.promises = arr(r.promises).map((p): PromiseEntry => {
    const o = (p ?? {}) as Record<string, unknown>;
    const arcRaw = str(o.arc) ?? 'planted';
    const arc = (['planted', 'pending', 'resolved', 'failed'].includes(arcRaw) ? arcRaw : 'planted') as PromiseArc;
    const promise: PromiseEntry = {
      id: str(o.id) ?? '',
      name: str(o.name) ?? '',
      arc,
      setups: arr(o.setups).map((s) => {
        const so = (s ?? {}) as Record<string, unknown>;
        const setup: PromiseSetup = { chapter: str(so.chapter) ?? '' };
        const line = num(so.line);
        if (line !== undefined) setup.line = line;
        const quote = str(so.quote);
        if (quote !== undefined) setup.quote = quote;
        return setup;
      }),
      payoffs: arr(o.payoffs).map((x) => {
        const xo = (x ?? {}) as Record<string, unknown>;
        const payoff: PromisePayoff = { chapter: str(xo.chapter) ?? '' };
        const line = num(xo.line);
        if (line !== undefined) payoff.line = line;
        const quote = str(xo.quote);
        if (quote !== undefined) payoff.quote = quote;
        return payoff;
      }),
    };
    const heat = str(o.heat);
    if (heat === 'HOT' || heat === 'WARM' || heat === 'COLD') promise.heat = heat;
    const due = num(o.due);
    if (due !== undefined) promise.due = due;
    const note = str(o.note);
    if (note !== undefined) promise.note = note;
    // 批三-2 新字段（容错）：expectedVolume 自由字符串；links 需 { props?/characters? } 字符串数组（容错过滤）
    const expectedVolume = str(o.expectedVolume);
    if (expectedVolume !== undefined) promise.expectedVolume = expectedVolume;
    const linksRaw = o.links;
    if (linksRaw !== null && typeof linksRaw === 'object' && !Array.isArray(linksRaw)) {
      const lo = linksRaw as Record<string, unknown>;
      const lProps = strArr(lo.props);
      const lChars = strArr(lo.characters);
      if (lProps.length > 0 || lChars.length > 0) {
        const links: { props?: string[]; characters?: string[] } = {};
        if (lProps.length > 0) links.props = lProps;
        if (lChars.length > 0) links.characters = lChars;
        promise.links = links;
      }
    }
    return promise;
  });
  base.knowledge = arr(r.knowledge).map((k): KnowledgeEntry => {
    const o = (k ?? {}) as Record<string, unknown>;
    const entry: KnowledgeEntry = { character: str(o.character) ?? '', knows: knowledgeFacts(o.knows) };
    const doesNotKnow = knowledgeFacts(o.doesNotKnow);
    if (doesNotKnow.length > 0) entry.doesNotKnow = doesNotKnow;
    const vis = str(o.visibility);
    if (vis === 'public' || vis === 'selective' || vis === 'secret') entry.visibility = vis;
    const knownBy = strArr(o.knownBy);
    if (knownBy.length > 0) entry.knownBy = knownBy;
    return entry;
  });
  base.doNotReexplain = strArr(r.doNotReexplain);
  base.protect = arr(r.protect).map((p): ProtectEntry => {
    if (typeof p === 'string') return { item: p };
    const o = (p ?? {}) as Record<string, unknown>;
    const entry: ProtectEntry = { item: str(o.item) ?? '' };
    const reason = str(o.reason);
    if (reason !== undefined) entry.reason = reason;
    return entry;
  });
  base.tripwires = strArr(r.tripwires);
  return base;
}

/**
 * 组装 YAML 前的 knowledge 事实：只有 fact、无 since/refs 的项写回**纯字符串**（旧账本 round-trip 格式不变）；
 * 带 since/refs 的项写对象。serializeLedger 调用前做一次转换，保证最小 diff。
 */
function knowledgeForYaml(list: KnowledgeFact[]): Array<string | Record<string, unknown>> {
  return list.map((f) => {
    // 带 quote 的项也写对象（不塌缩成纯字符串）：证据锚 schema（决策 0013）要求 quote round-trip 不丢
    if (f.since === undefined && (f.refs === undefined || f.refs.length === 0) && f.quote === undefined) return f.fact;
    const o: Record<string, unknown> = { fact: f.fact };
    if (f.since !== undefined) o.since = f.since;
    if (f.refs !== undefined && f.refs.length > 0) o.refs = f.refs;
    if (f.quote !== undefined) o.quote = f.quote;
    return o;
  });
}

/** 账本序列化为完整文件内容（YAML frontmatter + 渲染正文）；未知字段（extra）原样写回，与已知字段冲突时已知字段优先。 */
export function serializeLedger(ledger: Ledger, opts?: { chapterOrder?: ChapterRef[] }): string {
  const yaml = stringifyYaml(
    {
      ...(ledger.extra ?? {}), // 未知字段先展开，已知字段后覆盖 → 冲突时已知字段优先
      clock: ledger.clock,
      props: ledger.props,
      promises: ledger.promises,
      knowledge: ledger.knowledge.map((k) => ({
        character: k.character,
        knows: knowledgeForYaml(k.knows),
        ...(k.doesNotKnow !== undefined && k.doesNotKnow.length > 0 ? { doesNotKnow: knowledgeForYaml(k.doesNotKnow) } : {}),
        ...(k.visibility !== undefined ? { visibility: k.visibility } : {}),
        ...(k.knownBy !== undefined && k.knownBy.length > 0 ? { knownBy: k.knownBy } : {}),
      })),
      doNotReexplain: ledger.doNotReexplain,
      protect: ledger.protect,
      tripwires: ledger.tripwires,
    },
    { lineWidth: 0 },
  );
  return `---\n${yaml}---\n\n${renderLedgerMarkdown(ledger, opts)}`;
}

// ---------- 读写（文件系统） ----------

/** 匹配文件开头的 `---` 包裹块（与 frontmatter.ts 同口径，只取内层 YAML）。 */
const LEDGER_FM_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/;

/** 解析账本文件内容 → Ledger；无 frontmatter、YAML 非法或非映射时抛「损坏」错误（文件不存在的空账本由 readLedger 区分）。 */
export function parseLedger(content: string): Ledger {
  const m = LEDGER_FM_RE.exec(content);
  if (!m) {
    throw new Error('账本已损坏，需人工修复或删除：缺少 YAML frontmatter');
  }
  let raw: unknown;
  try {
    raw = parseYaml(m[1] ?? '');
  } catch (err) {
    throw new Error(`账本已损坏，需人工修复或删除：YAML 解析失败（${err instanceof Error ? err.message : String(err)}）`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('账本已损坏，需人工修复或删除：frontmatter 必须是 YAML 映射');
  }
  return normalizeLedger(raw);
}

/**
 * 账本/问题日志元数据文件路径白名单（相对 workDir 的 POSIX 路径；.md 后缀大小写不敏感）。
 * - 账本（ledgerPath）：只允许 .novel/ 根目录正下的 .md（不含子目录，匹配 ^\.novel/[^/]+\.md$），如 .novel/ledger.md；
 * - 问题日志（issueLogPath）：只允许 .novel/ 根下的 .md 或 editorial_notes/ 下的 .md，如 editorial_notes/issues.md。
 * 白名单化口径：账本/问题日志都是元数据文件，manuscript/ 章正文、.novel/history/ 旧章快照、.novel/notes/ 私有笔记、
 * 根目录与 editorial_notes 下其他 .md 一律不得被整文件重写或注入（防 ledger_upsert 重写 AGENTS.md、防旧章正文尾段进 LLM 上下文）。
 */
const LEDGER_PATH_RE = /^\.novel\/[^/]+\.md$/i;
const ISSUE_LOG_PATH_RE = /^editorial_notes\/.+\.md$/i;

/**
 * 校验账本/问题日志路径（相对 workDir 解析，越界抛错），返回规范化绝对路径。
 * 本文件内 ledgerAbs、ledger_slice、diagnosticsForWork 三处守卫共用此函数，禁止各自复制口径。
 */
function assertLedgerMetaPath(workDir: string, relPath: string, kind: 'ledger' | 'issueLog'): string {
  const label = kind === 'ledger' ? 'ledgerPath' : 'issueLogPath';
  const wd = assertWorkDir(workDir);
  const abs = resolveInside(wd, relPath); // 越界在此抛错
  const posix = toPosix(path.relative(wd, abs));
  if (!posix.toLowerCase().endsWith('.md')) {
    throw new Error(`${label} 只允许 .md 文件: ${relPath}`);
  }
  const allowed = kind === 'ledger' ? LEDGER_PATH_RE.test(posix) : LEDGER_PATH_RE.test(posix) || ISSUE_LOG_PATH_RE.test(posix);
  if (!allowed) {
    const scope = kind === 'ledger' ? '只允许 .novel/ 根目录下的 .md 文件' : '只允许 .novel/ 根下或 editorial_notes/ 下的 .md 文件';
    throw new Error(`${label} ${scope}: ${relPath}`);
  }
  return abs;
}

/**
 * 账本文件绝对路径（相对 workDir 解析，越界抛错）。
 * 守卫口径（白名单化）：账本是元数据文件，ledgerPath 必须是 .novel/ 根目录正下的 .md（相对路径匹配 ^\.novel/[^/]+\.md$，
 * 不含子目录）；默认 DEFAULT_LEDGER_PATH（.novel/ledger.md）天然合法。manuscript/、editorial_notes/、.novel/ 子目录内
 * 及根目录下的其他 .md 一律拒绝——防止 ledger_upsert 整文件重写 AGENTS.md、编辑笔记或章正文。
 */
function ledgerAbs(workDir: string, ledgerPath: string): string {
  return assertLedgerMetaPath(workDir, ledgerPath || DEFAULT_LEDGER_PATH, 'ledger');
}

/** 本地时间戳（毫秒级）+ 随机后缀，避免同刻碰撞；字典序即时间序。 */
function ledgerStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const base =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
  return `${base}-${randomBytes(2).toString('hex')}`;
}

/** ledgerPath 拍平成 .novel/history/ 下的单段目录名。 */
function flattenLedgerRel(relPath: string): string {
  return relPath.replace(/[:/\\]+/g, '__').replace(/\.md$/i, '');
}

/** .novel/history 的绝对路径（自动创建）。 */
function ledgerHistoryDir(workDir: string): string {
  const dir = path.join(assertWorkDir(workDir), '.novel', 'history');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 覆盖写账本前把旧内容快照进 .novel/history/<拍平的账本路径>/<时间戳>.md。
 * 仅当旧文件存在且内容有变化时快照；随后按时间序裁到最近 SNAPSHOT_KEEP 份。
 */
function snapshotLedgerBeforeWrite(workDir: string, relPath: string, abs: string, next: string): void {
  let prev: string;
  try {
    prev = fs.readFileSync(abs, 'utf8');
  } catch {
    return; // 新文件无旧版可快照
  }
  if (prev === next) return; // 内容未变不产生重复快照
  const dir = path.join(ledgerHistoryDir(workDir), flattenLedgerRel(toPosix(relPath)));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ledgerStamp()}.md`), prev, 'utf8');
  // 滚动裁剪：文件名以时间戳开头，字典序即时间序
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  for (const stale of names.slice(0, Math.max(0, names.length - SNAPSHOT_KEEP))) {
    fs.rmSync(path.join(dir, stale), { force: true });
  }
}

/** 读取账本；文件不存在返回空账本（不抛错），文件存在但解析失败抛「损坏」错误。 */
export function readLedger(workDir: string, ledgerPath?: string): { ledger: Ledger; path: string } {
  const wd = assertWorkDir(workDir);
  const rel = ledgerPath || DEFAULT_LEDGER_PATH;
  const abs = ledgerAbs(wd, rel);
  let content: string;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ledger: emptyLedger(), path: rel };
    throw err;
  }
  try {
    return { ledger: parseLedger(content), path: rel };
  } catch (err) {
    throw new Error(`账本已损坏，需人工修复或删除: ${rel}（${err instanceof Error ? err.message : String(err)}）`);
  }
}

/**
 * 全书章序（title 直接用文件名去 .md，不读章正文——读 frontmatter 取 title 在写/冷读路径太贵）；
 * 「第10章不再排到第2章前」：编号感知排序（复用 fsutil 的 compareNames，第2章 < 第10章），
 * 修正 collectMdFiles 路径字典序在 >9 章/汉字编号时错序的 bug。渲染时间轴化与逾期标记用。
 */
export function chapterOrderForWork(wd: string): ChapterRef[] {
  return sortMdFilesNumberAware(collectMdFiles(path.join(wd, 'manuscript'))).map((f) => ({
    relPath: toPosix(path.join('manuscript', f.rel)),
    title: path.basename(f.abs, '.md'),
  }));
}

/** 写账本（原子写，覆盖前对旧账本快照进 .novel/history/）；渲染视图带全书章序（时间轴化/逾期标记），返回 { ok, path, bytes }。 */
export function writeLedger(workDir: string, ledger: Ledger, ledgerPath?: string): { ok: true; path: string; bytes: number } {
  const wd = assertWorkDir(workDir);
  const rel = ledgerPath || DEFAULT_LEDGER_PATH;
  const abs = ledgerAbs(wd, rel);
  const content = serializeLedger(ledger, { chapterOrder: chapterOrderForWork(wd) });
  snapshotLedgerBeforeWrite(wd, rel, abs, content);
  const { bytes } = atomicWrite(abs, content);
  return { ok: true, path: rel, bytes };
}

/**
 * write_meta：写入书级元数据文件（如 .novel/style.md），原子写，写前对旧版本快照进 .novel/history/。
 * 边界（白名单化）：只允许 .novel/ 根目录正下的 .md（相对路径匹配 ^\.novel/[^/]+\.md$，不含子目录，
 * 守卫复用 assertLedgerMetaPath(kind:'ledger')）；拒写 manuscript 正文、问题日志、.novel/ 子目录；
 * 拒覆写账本——目标已存在且其内容能被 parseLedger 解析为账本时抛错（账本请走 ledger_upsert）。
 * 返回 { ok, path, bytes }。
 */
export function writeMeta(workDir: string, relPath: string, content: string): { ok: true; path: string; bytes: number } {
  const wd = assertWorkDir(workDir);
  const abs = assertLedgerMetaPath(wd, relPath, 'ledger'); // 白名单：.novel/ 根下 .md；越界/白名单外在此抛错
  // 目标已存在且能解析为账本 → 拒写（账本归 ledger_upsert 管，write_meta 只写书级元数据）
  if (fs.existsSync(abs)) {
    let isLedger = false;
    try {
      parseLedger(fs.readFileSync(abs, 'utf8'));
      isLedger = true;
    } catch {
      isLedger = false; // 解析不了 = 不是合法账本（书级元数据可覆盖；若恰为损坏账本则走 ledger 修复/删除流程）
    }
    if (isLedger) {
      throw new Error(`write_meta 拒绝覆写账本文件（本工具不写账本，账本请用 ledger_upsert）: ${relPath}`);
    }
  }
  const rel = toPosix(relPath);
  snapshotLedgerBeforeWrite(wd, rel, abs, content); // 旧版快照进 .novel/history/<拍平路径>/（复用账本快照口径）
  const { bytes } = atomicWrite(abs, content);
  return { ok: true, path: rel, bytes };
}

/**
 * read_style：读书级声口档案 .novel/style.md 全文（块2·② 全文可读回）。
 * 路径白名单与 write_meta 同口径（assertLedgerMetaPath，固定 .novel/style.md）；
 * 文件不存在返回 { exists: false }（= 尚未建档），不报错——系统提示的「## 声口摘要」只是投影，本工具是事实源。
 */
export function readStyle(
  workDir: string
): { exists: true; relPath: string; content: string; bytes: number } | { exists: false } {
  const wd = assertWorkDir(workDir);
  const abs = assertLedgerMetaPath(wd, '.novel/style.md', 'ledger');
  try {
    const content = fs.readFileSync(abs, 'utf8');
    return { exists: true, relPath: '.novel/style.md', content, bytes: Buffer.byteLength(content, 'utf8') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw err;
  }
}

/** 读文件当前状态（存在性 + mtimeMs + 内容摘要），供 upsert 的写前复核；文件不存在返回 exists=false。 */
function ledgerFileState(abs: string): { exists: boolean; mtimeMs: number; content: string } {
  try {
    const st = fs.statSync(abs);
    return { exists: true, mtimeMs: st.mtimeMs, content: fs.readFileSync(abs, 'utf8') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, mtimeMs: 0, content: '' };
    throw err;
  }
}

/**
 * 写前复核：文件状态与读时一致才放行；被其他进程改动（存在性/mtimeMs/内容摘要任一变化）则抛错且不写入。
 * noun 为报错主体名（账本/问题日志/裁决留痕），append 路径复用同款 CAS 口径。
 */
function assertLedgerUnchanged(
  abs: string,
  before: { exists: boolean; mtimeMs: number; content: string },
  noun = '账本',
): void {
  const now = ledgerFileState(abs);
  if (now.exists !== before.exists || now.mtimeMs !== before.mtimeMs || now.content !== before.content) {
    throw new Error(`${noun}已被其他进程修改，请重读后再试`);
  }
}

/**
 * 读 → 应用 ops → 写；返回更新后账本 + 写结果。账本损坏时拒绝写入（不覆盖）。
 * 轻量并发备注（不做锁）：读旧账本时记录其 mtimeMs/内容摘要，写前复核发现文件已被其他进程改动
 * 则抛「账本已被其他进程修改，请重读后再试」且不写入（read-modify-write 无 CAS 的兜底）。
 */
export function upsertLedger(
  workDir: string,
  ops: LedgerOp[],
  ledgerPath?: string,
): { ledger: Ledger; path: string; bytes: number } {
  const wd = assertWorkDir(workDir);
  const rel = ledgerPath || DEFAULT_LEDGER_PATH;
  const abs = ledgerAbs(wd, rel);
  const before = ledgerFileState(abs);
  const { ledger, path } = readLedger(workDir, rel);
  const next = applyOps(ledger, ops);
  assertLedgerUnchanged(abs, before);
  const { bytes } = writeLedger(workDir, next, path);
  return { ledger: next, path, bytes };
}

// ---------- 确定性诊断 ----------

export type FindingSeverity = 'BLOCKER' | 'MAJOR' | 'MODERATE' | 'MINOR';
export type FindingCategory = 'CONT' | 'CANON' | 'VOICE' | 'CRAFT' | 'STRUCT' | 'PACE' | 'REPEAT' | 'META';

/** 一条诊断发现（对齐 WS-9 issue 行格式，可拼成 CR 行）。 */
export interface LedgerFinding {
  /** 稳定代码，如 dangling-promise。 */
  code: string;
  /** 定位：章节引用（可为空，表示账本级）。 */
  chapter?: string;
  severity: FindingSeverity;
  category: FindingCategory;
  /** 一句话说明。 */
  message: string;
}

/**
 * 中文数字转阿拉伯数字（支持 一~九/十/百/千/万 组合，如「十二」「二十五」「一百零三」）。
 * 解析不了返回 undefined（宁缺毋滥：解析不出跳过比较，不误报）。
 */
function cnNum(s: string): number | undefined {
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  if (/^[零一二两三四五六七八九]$/.test(s)) return digits[s];
  let total = 0;
  let section = 0;
  let num = 0;
  for (const ch of s) {
    if (ch in digits) {
      num = digits[ch]!;
    } else if (ch in units) {
      const u = units[ch]!;
      if (ch === '十' && num === 0) num = 1; // 「十二」「十五」开头的十 = 1 十；「一十二」同样 = 12
      section += num * u;
      num = 0;
      if (ch === '万') {
        total += section;
        section = 0;
      }
    } else {
      return undefined; // 非法字符
    }
  }
  return total + section + num;
}

/** 解析「第 N 日/天」的 N（先阿拉伯数字，再中文数字）；解析不出返回 undefined。 */
function parseDayNumber(storyDay: string | undefined): number | undefined {
  if (!storyDay) return undefined;
  const m = /第(\d+)[日天]/.exec(storyDay);
  if (m) return Number(m[1]);
  const m2 = /第([零一二两三四五六七八九十百千万]+)[日天]/.exec(storyDay);
  if (m2) return cnNum(m2[1]!);
  return undefined;
}

/**
 * 账本级诊断（纯函数，不读文件）：悬空伏笔、逾期伏笔、道具双位冲突 + 批三-2 三条新规则
 * （clock-regression 时钟跨章倒退 / custody-chain-break 托管链断裂 / knowledge-no-knower 知情维首条规则）。
 * chapterOrder 为全书章顺序（用于逾期章距与时间轴化判定）；新规则一律按 orderIndex/titleOf 口径，
 * 找不到序号的条目跳过而非误报。
 *
 * BLOCKER 复核结论（决策 0009 批三-2 第 3 条）：新规则全部维持 MAJOR/MODERATE，确定性诊断不产 BLOCKER
 * 的纪律不变——倒叙叙事（clock-regression）、同章正常转手（custody-chain-break）都有误报面，宁缺毋滥，不升 BLOCKER。
 */
export function ledgerDiagnostics(ledger: Ledger, chapterOrder: ChapterRef[] = []): LedgerFinding[] {
  const findings: LedgerFinding[] = [];
  const orderIndex = new Map(chapterOrder.map((c, i) => [c.relPath, i]));
  const titleOf = (rel: string): string => chapterOrder.find((c) => c.relPath === rel)?.title ?? rel;

  // clock-regression：同 thread 内（thread 缺失视为同一默认线）相邻 clock 行的「第 N 日/天」N 值倒退 → 报跨章连续性。
  // 行序 = 按「行内首个可定位章」的章序排，查不到的保持原相对序在后；任一相邻行解析不出 N 就跳过该比较。
  // 已知误报面：倒叙叙事会误报（故不升 BLOCKER）。
  {
    const rows = ledger.clock.map((r) => {
      let idx: number | undefined;
      for (const c of r.chapters) {
        const i = orderIndex.get(c);
        if (i !== undefined) {
          idx = i;
          break;
        }
      }
      return { row: r, idx };
    });
    if (orderIndex.size > 0) {
      rows.sort((a, b) => {
        if (a.idx !== undefined && b.idx !== undefined) return a.idx - b.idx;
        if (a.idx !== undefined) return -1;
        if (b.idx !== undefined) return 1;
        return 0;
      });
    }
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.row.thread ?? ''; // thread 缺失视为同一默认线
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    for (const [thread, list] of groups) {
      for (let i = 1; i < list.length; i++) {
        const prev = parseDayNumber(list[i - 1]!.row.storyDay);
        const cur = parseDayNumber(list[i]!.row.storyDay);
        if (prev === undefined || cur === undefined) continue; // 解析不出就跳过该比较（宁缺毋滥）
        if (cur < prev) {
          const anchor = list[i]!.row.chapters[0];
          findings.push({
            code: 'clock-regression',
            ...(anchor !== undefined ? { chapter: anchor } : {}),
            severity: 'MAJOR',
            category: 'CONT',
            message: `时钟跨章倒退：${thread === '' ? '默认线' : thread} 线「${list[i - 1]!.row.storyDay}」→「${list[i]!.row.storyDay}」（故事日数字倒退）`,
          });
        }
      }
    }
  }

  for (const p of ledger.promises) {
    if ((p.arc === 'planted' || p.arc === 'pending') && p.setups.length > 0 && p.payoffs.length === 0) {
      findings.push({
        code: 'dangling-promise',
        chapter: p.setups[p.setups.length - 1]!.chapter,
        severity: p.heat === 'HOT' ? 'MAJOR' : 'MODERATE',
        category: 'CONT',
        message: `伏笔「${p.id} ${p.name}」已埋设 ${p.setups.length} 处但未回收（arc=${p.arc}）`,
      });
    }
    // 逾期：最后埋设章之后又过了 ≥ due 章仍未回收
    if (p.due !== undefined && p.due >= 0 && (p.arc === 'planted' || p.arc === 'pending') && p.payoffs.length === 0 && p.setups.length > 0) {
      const lastSetup = p.setups[p.setups.length - 1]!.chapter;
      const lastIdx = orderIndex.get(lastSetup);
      if (lastIdx !== undefined && chapterOrder.length - 1 - lastIdx >= p.due) {
        findings.push({
          code: 'overdue-promise',
          chapter: lastSetup,
          severity: p.heat === 'HOT' ? 'MAJOR' : 'MODERATE',
          category: 'CONT',
          message: `伏笔「${p.id}」自 ${titleOf(lastSetup)} 埋设后已过 ≥${p.due} 章未回收（逾期）`,
        });
      }
    }
  }

  for (const prop of ledger.props) {
    // 同一章内出现两个不同持有者 → 双位冲突
    const byChapter = new Map<string, string[]>();
    for (const c of prop.custody) {
      const list = byChapter.get(c.chapter) ?? [];
      if (c.holder && !list.includes(c.holder)) list.push(c.holder);
      byChapter.set(c.chapter, list);
    }
    for (const [chapter, holders] of byChapter) {
      if (holders.length >= 2) {
        findings.push({
          code: 'custody-conflict',
          chapter,
          severity: 'MAJOR',
          category: 'CONT',
          message: `道具「${prop.name}」在 ${titleOf(chapter)} 内同时登记持有者 ${holders.join(' / ')}（双位/双位同时在场矛盾）`,
        });
      }
    }
    // custody-chain-break(a)：托管链末端（按章序排，查不到序号的步骤保持数组序在后）持有者与当前持有者都存在且不一致
    if (prop.custody.length > 0 && prop.holder !== undefined && prop.holder !== '') {
      const sortedSteps = prop.custody.map((c) => {
        const i = orderIndex.get(c.chapter);
        return { step: c, idx: i };
      });
      if (orderIndex.size > 0) {
        sortedSteps.sort((a, b) => {
          if (a.idx !== undefined && b.idx !== undefined) return a.idx - b.idx;
          if (a.idx !== undefined) return -1;
          if (b.idx !== undefined) return 1;
          return 0;
        });
      }
      const lastHolder = sortedSteps[sortedSteps.length - 1]!.step.holder;
      if (lastHolder !== undefined && lastHolder !== '' && lastHolder !== prop.holder) {
        findings.push({
          code: 'custody-chain-break',
          chapter: sortedSteps[sortedSteps.length - 1]!.step.chapter,
          severity: 'MAJOR',
          category: 'CONT',
          message: `道具「${prop.name}」托管链末端持有者 ${lastHolder} 与当前持有者 ${prop.holder} 矛盾`,
        });
      }
    }
    // custody-chain-break(b)：chapterOrder 非空时，托管链步骤引用的章不在 chapterOrder 中
    if (chapterOrder.length > 0) {
      for (const c of prop.custody) {
        if (!orderIndex.has(c.chapter)) {
          findings.push({
            code: 'custody-chain-break',
            chapter: c.chapter,
            severity: 'MODERATE',
            category: 'CONT',
            message: `道具「${prop.name}」托管链引用不存在的章: ${c.chapter}`,
          });
        }
      }
    }
  }

  // knowledge-no-knower（知情维首条规则）：visibility 为 selective/secret 且 knownBy 为空/缺失 → 保密/选择可见但无知情人登记
  for (const k of ledger.knowledge) {
    if ((k.visibility === 'selective' || k.visibility === 'secret') && (!k.knownBy || k.knownBy.length === 0)) {
      findings.push({
        code: 'knowledge-no-knower',
        severity: 'MODERATE',
        category: 'CANON',
        message: `角色「${k.character}」保密/选择可见但无知情人登记（knownBy 为空）`,
      });
    }
  }
  return findings;
}

// ---------- 章正文确定性检查（纯函数，可独立测试） ----------

/**
 * 相对偏移时间表达（T2 timeline 子集，自研实现）：时间量词 + 后/前/以前/之前 结尾。
 * 承接日（次日/翌日/当晚/当天）单独排除，不算章首断链。
 */
const REL_OFFSET_RE =
  /(次日|翌日|第[二三四五六七八九十百\d]+[天日]|[一二两三四五六七八九十百半\d]+[天日年月]|数日|几日|几天|数月|几年|上月|下月|上周|下周|当天|当晚|今日|明日|昨日|前日|近年|近几日|近半年|片刻|不久)[^，。；！？\s]{0,10}(后|以前|之前|前)/;

/** 章节首跳变：章首 80 字内相对偏移且以 后/前/以前/之前 结尾 → 事件时间线在章首断开。 */
export function diagnoseChapterHeadJump(body: string): { hit: boolean; phrase?: string } {
  const head = body.replace(/^\s+/, '').slice(0, 80);
  const m = REL_OFFSET_RE.exec(head);
  if (!m) return { hit: false };
  const token = m[1] ?? '';
  // 承接日不算跳变（T2 规则）
  if (['次日', '翌日', '当晚', '当天'].includes(token)) return { hit: false };
  return { hit: true, phrase: m[0] };
}

/** 季节词表（只收多字明确季节词，避免单字「春/夏/秋/冬」误伤人名）。 */
const SEASON_WORDS: Record<'春' | '夏' | '秋' | '冬', string[]> = {
  春: ['初春', '开春', '春天', '春日', '春季', '暮春'],
  夏: ['初夏', '盛夏', '夏天', '夏日', '夏季', '酷暑'],
  秋: ['初秋', '深秋', '秋天', '秋日', '秋季', '暮秋'],
  冬: ['初冬', '深冬', '寒冬', '冬天', '冬日', '冬季'],
};

/**
 * 季节冲突：同一章正文出现两个不同季节档的词 → 时钟漂移风险。
 * 已知误报面（宁缺毋滥边界）：倒叙段（回忆当年某个季节）或对话里提及其他季节，
 * 会与当前叙事季节并置而被误报；本实现不做倒叙排除（T2 规则要求 sidecar 段落序才可，
 * 无 sidecar 硬写必误报）。severity 固定 MODERATE，作为提示而非硬判定。
 */
export function diagnoseSeasonConflict(body: string): { seasons: string[]; conflict: boolean } {
  const found: Array<'春' | '夏' | '秋' | '冬'> = [];
  for (const s of Object.keys(SEASON_WORDS) as Array<'春' | '夏' | '秋' | '冬'>) {
    if (SEASON_WORDS[s].some((w) => body.includes(w))) found.push(s);
  }
  return { seasons: found, conflict: found.length >= 2 };
}

// ---------- 审阅输入组装（禁止全量注入正文） ----------

/** 冷读契约摘要（兜底，正本在 core/prompts/cold-read.md；文件缺失/损坏时退回本串）。 */
export const COLD_READ_CHARTER = `读者契约（小说写作工作台 冷读摘要）：
- 身份：刚付费买下本书的网文读者，带编辑的耳朵；先体验后诊断，每条问题都要能说出打断阅读的瞬间。
- Rule zero：不改 manuscript 正文，全部产出进 editorial_notes。
- 严重度：BLOCKER（破坏信任）/ MAJOR（重读略读）/ MODERATE（原谅一次不原谅三次）/ MINOR（打磨）。
- 类别：CONT 连续性 · CANON 设定冲突 · VOICE 口吻 · CRAFT show-then-tell · STRUCT 结构 · PACE 节奏 · REPEAT 重复 · META 元数据。
- 问题行格式：CR-### | ch:line | SEV | CAT | "quote" | why / reader-moment | fix direction | LINE/SCENE/STRUCT/META`;

/**
 * 冷读 slice 模板（兜底，正本在 core/prompts/cold-read.md）。
 * 占位符契约（与 cold-read.md 一致）：
 * {{账本切片}} 账本渲染、{{章节标题}} 章标题、{{章节内容}} 单章正文、{{问题日志尾部}} 问题日志尾部。
 */
const COLD_READ_SLICE_TEMPLATE = [
  '# 冷读输入（单章 + 账本切片）',
  '',
  '## 读者契约',
  COLD_READ_CHARTER,
  '',
  '## 账本（当前状态）',
  '',
  '{{账本切片}}',
  '## 本章正文（唯一注入章）',
  '',
  '### {{章节标题}}',
  '',
  '{{章节内容}}',
  '',
  '## 问题日志（尾部，供续读上下文）',
  '',
  '{{问题日志尾部}}',
  '',
  '## 输出要求',
  '- 只依据本章正文 + 账本状态判断，不臆造；',
  '- 严禁读取/注入本书其他章节全文；',
  '- 输出必须是严格 JSON 对象，形如 {"elements": [...]}，每个元素为 { severity: "BLOCKER"|"MAJOR"|"MODERATE"|"MINOR", quote: string, why: string, suggestion?: string, category?: string }；severity 只能取 BLOCKER/MAJOR/MODERATE/MINOR；quote 是该章正文里的原文短引；category 可选，只取 CONT/CANON/VOICE/CRAFT/STRUCT/PACE/REPEAT/META 之一，判断不了就省略；只输出该 JSON 对象本身，不要 Markdown 代码块、不要解释、不要任何前后缀；没有发现时输出 {"elements": []}。',
  '',
].join('\n') + '\n';

/** cold-read.md 模板占位符：四个动态段都必须存在，缺任一视为模板损坏，回退兜底模板。 */
const COLD_READ_PLACEHOLDERS = ['{{账本切片}}', '{{章节标题}}', '{{章节内容}}', '{{问题日志尾部}}'] as const;

/** 剥掉 md 里的 HTML 注释（cold-read.md 用注释给加载方说明占位符，注释里也含占位符文本，不能参与替换）。 */
function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->\r?\n?/g, '');
}

function coldReadSliceTemplate(): string {
  const loaded = loadPrompt('cold_read');
  if (loaded !== null) {
    const template = stripHtmlComments(loaded);
    if (COLD_READ_PLACEHOLDERS.every((p) => template.includes(p))) {
      return template;
    }
    console.warn(
      '[ledger] cold-read.md 缺少模板占位符（{{账本切片}}/{{章节标题}}/{{章节内容}}/{{问题日志尾部}}），回退兜底模板'
    );
  }
  return COLD_READ_SLICE_TEMPLATE;
}

/** ledger_slice 注入问题日志尾部行数（单一事实源；server.ts ledger_slice 工具描述串复用同一常量）。 */
export const ISSUE_LOG_TAIL_LINES = 40;

/**
 * ledgerSlice：组装冷读输入（贵档模型用）——单章正文 + 账本切片 + 问题日志尾部。
 * 纪律：只注入「当前章」这一章正文，绝不注入其他章全文；账本为结构化切片（本就很小）。
 * 模板从 cold-read.md 加载（改文件即生效），失败回退上面的兜底常量。
 */
export function ledgerSlice(
  workDir: string,
  chapterRelPath: string,
  ledgerPath?: string,
  issueLogPath?: string,
  opts?: { budget?: number },
): { workDir: string; chapterRelPath: string; slice: string; injectedChapters: string[] } {
  const wd = assertWorkDir(workDir);
  const { ledger } = readLedger(wd, ledgerPath);

  // 全书章序供账本切片渲染做时间轴化排序/逾期标记（批三-2，决策 0009；与 writeLedger 同口径）。
  const chapterOrder: ChapterRef[] = chapterOrderForWork(wd);

  // 读单章正文（守卫：只允许 manuscript/ 内的 .md，防止把全稿 txt 或 .novel 内文件当章注入）
  const abs = resolveInside(wd, chapterRelPath); // 越界在此抛错
  const chapterPosix = toPosix(path.relative(wd, abs));
  if (!chapterPosix.startsWith('manuscript/') || !chapterPosix.toLowerCase().endsWith('.md')) {
    throw new Error(`ledger_slice 的 chapterRelPath 只允许 manuscript/ 内的 .md 文件: ${chapterRelPath}`);
  }
  let chapterContent: string;
  try {
    chapterContent = fs.readFileSync(abs, 'utf8');
  } catch {
    throw new Error(`ledger_slice 章节不存在: ${chapterRelPath}`);
  }
  const body = chapterContent.slice(frontmatterEnd(chapterContent));
  const title = chapterPosix.split('/').pop()?.replace(/\.md$/i, '') ?? chapterRelPath;

  // 问题日志尾部（WS-9：最后约 ISSUE_LOG_TAIL_LINES 行；守卫：白名单 .novel/ 根下 .md 或 editorial_notes/ 下 .md，其余一律抛错）
  let issueTail = '';
  if (issueLogPath) {
    const issueAbs = assertLedgerMetaPath(wd, issueLogPath, 'issueLog'); // 越界/白名单外在此抛错
    try {
      const issueContent = fs.readFileSync(issueAbs, 'utf8');
      const lines = issueContent.split(/\r?\n/);
      issueTail = lines.slice(-ISSUE_LOG_TAIL_LINES).join('\n');
    } catch {
      issueTail = '（问题日志不存在或不可读）';
    }
  }

  const template = coldReadSliceTemplate();
  // 4.1 冷读预算闸（reference/05 §批次结构）：opts.budget 传入时，{{账本切片}} 走索引层区间裁剪
  // （类型配额，压进预算；composition 供注入可见性）——缺省不传则维持原全量渲染路径，行为零变。
  let ledgerSection: string | null = null;
  let sliceExtra: Record<string, unknown> | null = null;
  if (opts?.budget !== undefined) {
    const cut = indexedSliceForWork(wd, chapterPosix, ledger, chapterOrder, { budget: opts.budget });
    ledgerSection = cut.lines.length ? cut.lines.join('\n') : '（账本在预算内无生效条目）';
    sliceExtra = { ledgerSliceChars: cut.chars, ledgerSliceBudget: opts.budget, ledgerSliceDropped: cut.dropped, ledgerSliceComposition: cut.composition };
  }
  // 单趟替换四个占位符（一次扫描，替换结果不再被扫描）：避免「正文/标题/日志尾部」这类用户可控文本里
  // 恰好含其它占位 token 时被后续 replaceAll 二次替换、混入审阅输入。
  const slice = template.replace(
    /\{\{账本切片\}\}|\{\{章节标题\}\}|\{\{章节内容\}\}|\{\{问题日志尾部\}\}/g,
    (token) => {
      switch (token) {
        case '{{账本切片}}':
          return ledgerSection ?? renderLedgerMarkdown(ledger, { chapterOrder });
        case '{{章节标题}}':
          return title;
        case '{{章节内容}}':
          return body.trim();
        default:
          return issueTail || '（无）';
      }
    }
  );

  return { workDir: wd, chapterRelPath, slice, injectedChapters: [chapterRelPath], ...(sliceExtra ? sliceExtra : {}) };
}

export interface LedgerChapterSliceResult {
  workDir: string;
  chapterRelPath: string;
  found: boolean;
  chapterTitle: string | null;
  ledger: Ledger;
  slice: string;
}

/**
 * ledger_chapter_slice：按章过滤的账本视图（只读，不写账本、不注入全账本）。
 * - chapterRelPath 必须是 manuscript/ 内的 .md（守卫口径同 ledgerSlice 约 1359-1361）；
 * - ledgerPath 走 assertLedgerMetaPath(kind:'ledger') 白名单（readLedger 内部已复用该守卫）；
 * - 章在 chapterOrder（编号感知章序）内 → found=true：ledger = filterLedgerForChapter 结果，
 *   slice = renderLedgerMarkdown(过滤后账本, { chapterOrder: chapterOrderForWork(wd) })，
 *   chapterTitle 取自 chapterOrder 条目；章不在序内 → found=false：空账本 + slice='' + chapterTitle=null。
 */
export function ledgerChapterSlice(
  workDir: string,
  chapterRelPath: string,
  ledgerPath?: string,
): LedgerChapterSliceResult {
  const wd = assertWorkDir(workDir);
  const { ledger } = readLedger(wd, ledgerPath);
  const chapterOrder: ChapterRef[] = chapterOrderForWork(wd);

  // 守卫（复用 ledgerSlice 口径）：只允许 manuscript/ 内的 .md，防止把全稿/元数据当章切片
  const abs = resolveInside(wd, chapterRelPath); // 越界在此抛错
  const chapterPosix = toPosix(path.relative(wd, abs));
  if (!chapterPosix.startsWith('manuscript/') || !chapterPosix.toLowerCase().endsWith('.md')) {
    throw new Error(`ledger_chapter_slice 的 chapterRelPath 只允许 manuscript/ 内的 .md 文件: ${chapterRelPath}`);
  }

  const entry = chapterOrder.find((c) => c.relPath === chapterPosix);
  if (!entry) {
    return {
      workDir: wd,
      chapterRelPath,
      found: false,
      chapterTitle: null,
      ledger: emptyLedger(),
      slice: '',
    };
  }
  const filtered = filterLedgerForChapter(ledger, chapterOrder, chapterPosix) ?? emptyLedger();
  return {
    workDir: wd,
    chapterRelPath,
    found: true,
    chapterTitle: entry.title,
    ledger: filtered,
    slice: renderLedgerMarkdown(filtered, { chapterOrder }),
  };
}

// ---------- 全作品诊断编排（读账本 + 逐章正文） ----------

export interface WorkDiagnostics {
  workDir: string;
  findings: LedgerFinding[];
  /** 是否存在 BLOCKER 级发现（确定性诊断 BLOCKER + 问题日志 BLOCKER 计数），供暂存区入口标红提示；不做硬拦截。 */
  hasBlockers: boolean;
  /** 问题日志（issues.md，CR 格式）里 severity 列为 BLOCKER 且 status 列缺失/为空/open 的条数（已处置 done/known 不计）；未提供 issueLogPath 或日志缺失时为 0。 */
  blockerCount: number;
  /** 可选加法：读取失败被跳过的章/目录清单（空时不出现）；作者据此知道哪些章没诊断到。 */
  skipped?: SkippedEntry[];
}

/**
 * 对 workDir 跑全量确定性诊断：账本级（悬空/逾期/双位）+ 章级（章首跳变/季节冲突），
 * 并把问题日志（issues.md，CR 格式）的 BLOCKER 计数（severity 列 + 未处置 status 列判定）折叠进 hasBlockers——
 * 冷读产出的未处置 BLOCKER 条目由本函数统一汇总，接进「暂存区入口标红提示」出口。
 * signal 可选（加法）：逐章读文件循环每轮检查，取消时抛 AbortError 提前退出全量扫描。
 */
export function diagnosticsForWork(workDir: string, ledgerPath?: string, issueLogPath?: string, signal?: AbortSignal): WorkDiagnostics {
  const wd = assertWorkDir(workDir);
  const { ledger } = readLedger(wd, ledgerPath);

  const skipped: SkippedEntry[] = [];
  const files = sortMdFilesNumberAware(
    collectMdFiles(path.join(wd, 'manuscript'), (rel, err) => {
      skipped.push({ path: toPosix(path.join('manuscript', rel || '.')), reason: errText(err) });
    }),
  );
  const chapterOrder: ChapterRef[] = [];
  const bodies: Array<{ relPath: string; title: string; body: string }> = [];
  for (const f of files) {
    signal?.throwIfAborted(); // 全量扫描：逐章取消检查
    let content: string;
    try {
      content = fs.readFileSync(f.abs, 'utf8');
    } catch (err) {
      // 不再静默漏章：warn + 记入 skipped，让作者知道哪些章没诊断到
      console.warn(`[diagnostics] 章读取失败已跳过: ${f.abs}（${errText(err)}）`);
      skipped.push({ path: toPosix(path.join('manuscript', f.rel)), reason: errText(err) });
      continue;
    }
    const fm = parseFrontmatter(content);
    const title = fm.title ?? path.basename(f.abs, '.md');
    const relPath = toPosix(path.join('manuscript', f.rel));
    chapterOrder.push({ relPath, title });
    bodies.push({ relPath, title, body: content.slice(frontmatterEnd(content)) });
  }

  const findings = ledgerDiagnostics(ledger, chapterOrder);
  for (const b of bodies) {
    const headJump = diagnoseChapterHeadJump(b.body);
    if (headJump.hit) {
      findings.push({
        code: 'clock-head-jump',
        chapter: b.relPath,
        severity: 'MODERATE',
        category: 'CONT',
        message: `「${b.title}」章首出现相对时间偏移（${headJump.phrase ?? '?'}）——事件时间线在章首断开，需给出承接或重设锚`,
      });
    }
    const season = diagnoseSeasonConflict(b.body);
    if (season.conflict) {
      findings.push({
        code: 'season-conflict',
        chapter: b.relPath,
        severity: 'MODERATE',
        category: 'CONT',
        message: `「${b.title}」同一章出现多个季节信号（${season.seasons.join('/')}）——时钟漂移风险，需锚定单一季节`,
      });
    }
  }
  let blockerCount = 0;
  if (issueLogPath) {
    const issueAbs = assertLedgerMetaPath(wd, issueLogPath, 'issueLog'); // 越界/白名单外在此抛错（与 ledger_slice 同口径）
    try {
      const issueLog = fs.readFileSync(issueAbs, 'utf8');
      blockerCount = countBlockers(issueLog).blockers;
    } catch {
      blockerCount = 0; // 问题日志缺失/不可读 → 视为无 BLOCKER 条目
    }
  }
  const hasBlockers = findings.some((f) => f.severity === 'BLOCKER') || blockerCount > 0;
  return { workDir: wd, findings, hasBlockers, blockerCount, ...(skipped.length > 0 ? { skipped } : {}) };
}

// ---------- BLOCKER 清零提示出口 ----------

/**
 * 解析 issue 日志（CR 格式：`|` 分隔列）里「未处置」BLOCKER 条数：第 3 个字段（severity 列）恰为 BLOCKER，
 * 且第 9 个字段（status 列，批三-1 新增）缺失/为空/open 的行才计数——已处置（done/known）不计，
 * 「清零」语义 = 处置后不计。
 * 不按行内任意位置的 "| BLOCKER |" 子串匹配——quote/why 字段含同样片段会多计。
 */
export function countBlockers(issueLogContent: string): { blockers: number; hasBlockers: boolean } {
  let n = 0;
  for (const line of issueLogContent.split(/\r?\n/)) {
    const fields = line.split('|').map((f) => f.trim());
    if (fields.length >= 3 && fields[2] === 'BLOCKER') {
      const status = fields[8] ?? '';
      if (status === '' || status === 'open') n += 1;
    }
  }
  return { blockers: n, hasBlockers: n > 0 };
}

// ---------- 问题日志（issues.md，CR 格式）读写（批三-1 闭环接通） ----------

/** 问题日志默认文件路径（相对 workDir）。 */
export const DEFAULT_ISSUE_LOG_PATH = 'editorial_notes/issues.md';

/** issue_append 单条入参：一条待追加的问题（对齐 WS-9 CR 行字段）。 */
export interface IssueFinding {
  severity: FindingSeverity;
  category?: FindingCategory;
  /** 原文引用（可带引号包裹，追加前会去引号 trim 后用于定位行号）。 */
  quote: string;
  why: string;
  /** 修复建议，缺省时 CR 行 fix 列填 `-`。 */
  suggestion?: string;
  /** 章节定位：manuscript/ 内 relPath（正斜杠），如 manuscript/卷一/第1章.md。 */
  chapter: string;
}

/** issue_append 允许的 severity/category 枚举（守卫校验用；与 MCP zod schema 同口径）。 */
const FINDING_SEVERITIES: FindingSeverity[] = ['BLOCKER', 'MAJOR', 'MODERATE', 'MINOR'];
const FINDING_CATEGORIES: FindingCategory[] = ['CONT', 'CANON', 'VOICE', 'CRAFT', 'STRUCT', 'PACE', 'REPEAT', 'META'];

/** CR 行任一字段内的 `|` 与换行统一替换为空格（行内禁止换行，防破坏 `|` 分隔格式）。 */
function crField(text: string): string {
  return text.replace(/[\r\n|]/g, ' ');
}

/** 去引号 + trim：quote 可能带 `"…"` / `“…”` 包裹，剥离后再参与定位与落列。 */
function unquoteQuote(text: string): string {
  let t = text.trim();
  while (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/**
 * 在 chapter 文件里找 quote 首次出现的文件实际行号（1 起始，含 frontmatter 行，与 search_content 口径一致）。
 * 两过匹配：先逐行精确子串（原行为，命中即返回）；未中再紧凑匹配（D7「跨行 quote 定位必失配」）——
 * 双侧剥掉全部空白字符（\s 含 \u00a0/\u3000，换行一并剥去）后在整章紧凑串里找首现，
 * quote 跨行/跨段（内含 \n、\r\n、段间空行）也能定位，返回首字符所在行号。
 * chapter 越界/非 manuscript 内 .md/不存在或两过都找不到 → 返回 null（CR 行 line 段写 `?`）。
 * 导出供对账器（reconcile.ts）复用同一套定位口径。
 */
export function locateQuoteLine(workDir: string, chapterRelPath: string, quote: string): number | null {
  let abs: string;
  try {
    abs = resolveInside(workDir, chapterRelPath);
  } catch {
    return null;
  }
  const posix = toPosix(path.relative(assertWorkDir(workDir), abs));
  if (!posix.startsWith('manuscript/') || !posix.toLowerCase().endsWith('.md')) return null;
  let content: string;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    return null; // chapter 不存在
  }
  const q = quote.trim();
  if (q === '') return null;
  const lowerQ = q.toLowerCase();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').toLowerCase().includes(lowerQ)) return i + 1;
  }
  // 紧凑兜底：剥全部空白后整章匹配。lineOf 与紧凑串同长，记录每个紧凑字符的原始行号（\n 计行、\r 不计）。
  const compactQ = lowerQ.replace(/\s/g, '');
  if (compactQ === '') return null;
  const compactChars: string[] = [];
  const lineOf: number[] = [];
  let line = 1;
  for (const ch of content) {
    if (ch === '\n') {
      line += 1;
      continue;
    }
    if (/\s/.test(ch)) continue;
    compactChars.push(ch);
    lineOf.push(line);
  }
  const idx = compactChars.join('').indexOf(compactQ);
  return idx >= 0 ? (lineOf[idx] ?? null) : null;
}

/**
 * issue_append：把 findings 追加进问题日志（CR 格式行文件），原子写回。
 * - 编号：扫现有 `CR-(\d+)` 取最大 +1 续号（3 位零填充）；
 * - 定位：quote 去引号 trim 后在 chapter 文件里找首次出现行号（文件实际行号含 frontmatter，与 search_content 同口径）；
 *   chapter 不存在或 quote 找不到则 line 段写 `?`；
 * - CR 行：scope 列固定 `-`、status 列固定 open（批三-1 新增状态列）；why/suggestion 分列 why 与 fix，
 *   suggestion 缺则 fix 列填 `-`；行内禁止换行，`|` 统一替换为空格；
 * - 文件不存在则创建（含父目录，带 `# 问题日志` 头行）；白名单（.novel/ 根下或 editorial_notes/ 下 .md）外抛错；
 * - 写前 CAS 复核（同 ledger_upsert 的 assertLedgerUnchanged）：读-改之间日志被外部改动则抛「问题日志已被其他进程修改」且不写入，
 *   防并发追加静默丢条目。
 */
export function issueAppend(
  workDir: string,
  findings: IssueFinding[],
  issueLogPath?: string,
): { appended: number; ids: string[]; path: string } {
  const wd = assertWorkDir(workDir);
  const rel = issueLogPath || DEFAULT_ISSUE_LOG_PATH;
  const abs = assertLedgerMetaPath(wd, rel, 'issueLog'); // 越界/白名单外在此抛错（与 ledger_slice 同口径）
  if (!Array.isArray(findings)) throw new Error('issue_append 的 findings 必须是数组');
  if (findings.length === 0) return { appended: 0, ids: [], path: rel }; // 空追加幂等 no-op，不建文件

  const before = ledgerFileState(abs); // 记录读时状态，写前复核用
  let existing = '';
  try {
    existing = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // 扫现有 `CR-(\d+)` 取最大编号 +1 续号
  let nextNo = 0;
  for (const m of existing.matchAll(/CR-(\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > nextNo) nextNo = n;
  }

  const rows: string[] = [];
  const ids: string[] = [];
  for (const f of findings) {
    if (!FINDING_SEVERITIES.includes(f.severity)) {
      throw new Error(`issue_append 的 severity 非法: ${String(f.severity)}（允许: ${FINDING_SEVERITIES.join('/')}）`);
    }
    if (f.category !== undefined && !FINDING_CATEGORIES.includes(f.category)) {
      throw new Error(`issue_append 的 category 非法: ${String(f.category)}（允许: ${FINDING_CATEGORIES.join('/')}）`);
    }
    if (typeof f.quote !== 'string' || f.quote.trim() === '') throw new Error('issue_append 的 quote 需要非空字符串');
    if (typeof f.why !== 'string' || f.why.trim() === '') throw new Error('issue_append 的 why 需要非空字符串');
    if (typeof f.chapter !== 'string' || f.chapter.trim() === '') throw new Error('issue_append 的 chapter 需要非空字符串');

    nextNo += 1;
    const id = `CR-${String(nextNo).padStart(3, '0')}`;
    ids.push(id);
    const quote = unquoteQuote(f.quote);
    const lineNo = locateQuoteLine(wd, f.chapter, quote);
    const location = `${crField(f.chapter.trim())}:${lineNo ?? '?'}`;
    const cat = f.category ?? 'META'; // category 缺省按 META（未归类）
    const fix = f.suggestion !== undefined && f.suggestion.trim() !== '' ? crField(f.suggestion) : '-';
    rows.push(`${id} | ${location} | ${f.severity} | ${cat} | "${crField(quote)}" | ${crField(f.why)} | ${fix} | - | open`);
  }

  // 拼接：文件不存在（或空内容）时带头行；已有内容保持原样追加（末尾补换行分隔）
  const header = existing.trim() === '' ? '# 问题日志\n\n' : '';
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  const next = existing + sep + header + rows.join('\n') + '\n';
  assertLedgerUnchanged(abs, before, '问题日志'); // 写前 CAS 复核：被外部改动则响亮报错，不静默丢条目
  atomicWrite(abs, next);
  return { appended: rows.length, ids, path: rel };
}

/**
 * issue_set_status：把 id（CR-NNN）所在行的 status 列改写为 open/done/known。
 * - 有 status 列则替换、无则行尾追加（批三-1 新增状态列，旧行无此列视为 open）；
 * - id 找不到抛中文错；同状态重复设置幂等成功（文件不变）；
 * - 白名单（.novel/ 根下或 editorial_notes/ 下 .md）外抛错。
 */
export function issueSetStatus(
  workDir: string,
  id: string,
  status: 'open' | 'done' | 'known',
  issueLogPath?: string,
): { ok: true; id: string; status: 'open' | 'done' | 'known' } {
  const wd = assertWorkDir(workDir);
  const rel = issueLogPath || DEFAULT_ISSUE_LOG_PATH;
  const abs = assertLedgerMetaPath(wd, rel, 'issueLog'); // 越界/白名单外在此抛错
  if (typeof id !== 'string' || !/^CR-\d+$/.test(id.trim())) {
    throw new Error(`issue_set_status 的 id 格式非法（应为 CR-NNN）: ${String(id)}`);
  }
  const target = id.trim();
  let existing: string;
  try {
    existing = fs.readFileSync(abs, 'utf8');
  } catch {
    throw new Error(`issue_set_status 找不到问题日志: ${rel}`);
  }

  const lines = existing.split(/\r?\n/);
  let found = false;
  let changed = false;
  const nextLines = lines.map((line) => {
    const fields = line.split('|');
    // 只认 CR 行（首字段为 id）；其他行误含该 id 文本时不动
    if ((fields[0] ?? '').trim() !== target) return line;
    found = true;
    const current = (fields[8] ?? '').trim();
    if (current === status) return line; // 幂等：同状态不再改写
    if (fields.length >= 9) {
      fields[8] = ` ${status}`; // 替换：保持原行其他列与间隔不变
      changed = true;
      return fields.join('|');
    }
    changed = true;
    return line.trimEnd() + ` | ${status}`; // 追加：旧行无 status 列，行尾补列
  });
  if (!found) throw new Error(`issue_set_status 找不到 id: ${target}`);
  if (changed) atomicWrite(abs, nextLines.join('\n'));
  return { ok: true, id: target, status };
}

// ---------- 裁决留痕（decisions.md） ----------

/** 裁决留痕默认文件路径（相对 workDir）。 */
const DEFAULT_DECISION_PATH = 'editorial_notes/decisions.md';

/** decision_tail 默认最多返回行数（单一事实源；server.ts 工具描述串复用同一常量）。 */
export const DECISION_TAIL_DEFAULT_LIMIT = 20;

/** 裁决枚举（z.enum 校验；与 MCP zod schema 同口径）。 */
const DECISION_RULING_SCHEMA = z.enum(['采纳', '驳回', '搁置']);

/**
 * decision_append：把一条裁决追加进裁决留痕（一行一条 `- D-NNN | 日期 | 议题 | 立场 | 裁决 | 理由 | 章1,章2`）。
 * - 编号：扫现有 `D-(\d+)` 取最大 +1 续号（3 位零填充）；日期服务端取当天（UTC，ISO 前 10 位）；
 * - chapters 缺省/空数组输出 `-`，非空则逐项清洗后逗号拼接；
 * - 字段清洗：topic/stance/reason/chapters 内 `[\r\n|]` 全换空格并 trim（crField，行内防破坏 `|` 分隔）；
 *   topic/stance/reason 非空校验、空抛中文错；ruling 用 z.enum 校验、枚举外抛中文错；
 * - 文件不存在（或空内容）时先写 `# 裁决留痕` 头再追加；白名单外抛错；原子写回；
 * - 写前 CAS 复核（同 ledger_upsert 口径）：读-改之间留痕被外部改动则抛「裁决留痕已被其他进程修改」且不写入。
 * 追加式留痕：推翻旧裁决请新增条目并引用原 D 编号，不改旧行。
 */
export function decisionAppend(
  workDir: string,
  params: { topic: string; stance: string; ruling: string; reason: string; chapters?: string[]; path?: string },
): { appended: number; id: string; path: string } {
  const wd = assertWorkDir(workDir);
  const rel = params.path || DEFAULT_DECISION_PATH;
  const abs = assertLedgerMetaPath(wd, rel, 'issueLog'); // 复用 issueLog 守卫：解析/越界/.md 前缀
  const posix = toPosix(path.relative(wd, abs));
  if (!posix.startsWith('editorial_notes/')) {
    throw new Error(`decision_append 的 path 只允许 editorial_notes/ 下的 .md 文件: ${rel}`);
  }
  const topic = crField(params.topic ?? '').trim();
  const stance = crField(params.stance ?? '').trim();
  const reason = crField(params.reason ?? '').trim();
  if (topic === '') throw new Error('decision_append 的 topic 需要非空字符串');
  if (stance === '') throw new Error('decision_append 的 stance 需要非空字符串');
  if (reason === '') throw new Error('decision_append 的 reason 需要非空字符串');
  if (!DECISION_RULING_SCHEMA.safeParse(params.ruling).success) {
    throw new Error(`decision_append 的 ruling 非法: ${String(params.ruling)}（允许: 采纳/驳回/搁置）`);
  }
  const chapters =
    params.chapters !== undefined && params.chapters.length > 0
      ? params.chapters.map((c) => crField(c).trim()).filter((c) => c !== '').join(',')
      : '-';

  const before = ledgerFileState(abs); // 先采样读时状态（同 issueAppend 口径），再读内容：杜绝「先读后采样」窗口内外部更新被 stale 内容覆盖丢失
  let existing = '';
  try {
    existing = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // 扫现有 `D-(\d+)` 取最大编号 +1 续号（3 位零填充）
  let nextNo = 0;
  for (const m of existing.matchAll(/D-(\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > nextNo) nextNo = n;
  }
  nextNo += 1;
  const id = `D-${String(nextNo).padStart(3, '0')}`;
  const date = new Date().toISOString().slice(0, 10);
  const row = `- ${id} | ${date} | ${topic} | ${stance} | ${params.ruling} | ${reason} | ${chapters}`;

  // 拼接：文件不存在（或空内容）时带头行；已有内容原样保留（末尾补换行分隔）
  const header = existing.trim() === '' ? '# 裁决留痕\n\n' : '';
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  assertLedgerUnchanged(abs, before, '裁决留痕'); // 写前 CAS 复核：被外部改动则响亮报错，不静默丢条目
  atomicWrite(abs, existing + sep + header + row + '\n');
  return { appended: 1, id, path: rel };
}

/**
 * decision_tail：只读裁决留痕尾部（path 固定 editorial_notes/decisions.md，不开放）。
 * - 文件不存在 → { total: 0, lines: [] }（降级，不抛错）；
 * - total = 全文件中所有「以 `- D-` 开头」行的总数；limit 默认 DECISION_TAIL_DEFAULT_LIMIT、上限 100；
 * - chapter 在场：先取「含该 chapter 子串」的行（保持原顺序），不足 limit 从尾部（最新）往前补齐不重复的行，
 *   超过 limit 截断；无 chapter 直接取尾部 limit 行；返回的 lines 一律按文件原顺序（旧的在前）。
 */
export function decisionTail(
  workDir: string,
  chapter?: string,
  limit?: number,
): { total: number; lines: string[] } {
  const wd = assertWorkDir(workDir);
  const abs = path.join(wd, DEFAULT_DECISION_PATH);
  let existing: string;
  try {
    existing = fs.readFileSync(abs, 'utf8');
  } catch {
    return { total: 0, lines: [] }; // 文件不存在降级
  }
  const lines = existing.split(/\r?\n/).filter((l) => l.startsWith('- D-'));
  const total = lines.length;
  let lim = DECISION_TAIL_DEFAULT_LIMIT;
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    lim = Math.min(100, Math.max(1, Math.floor(limit))); // 钳制到 [1, 100]
  }
  if (chapter === undefined || chapter === '') {
    return { total, lines: lines.slice(-lim) };
  }
  // chapter 过滤优先：行内含该子串即中，保持原顺序
  const selectedIdx = new Set<number>();
  lines.forEach((l, i) => {
    if (l.includes(chapter)) selectedIdx.add(i);
  });
  if (selectedIdx.size >= lim) {
    // 超过 limit 截断：按原顺序取前 lim 条（旧的在前）
    const kept = [...selectedIdx].sort((a, b) => a - b).slice(0, lim);
    return { total, lines: kept.map((i) => lines[i]!) };
  }
  // 不足 limit：从尾部（最新）往前补齐不重复的剩余行
  for (let i = lines.length - 1; i >= 0 && selectedIdx.size < lim; i--) {
    selectedIdx.add(i);
  }
  // 最终按文件原顺序（旧的在前）
  const out = [...selectedIdx].sort((a, b) => a - b).map((i) => lines[i]!);
  return { total, lines: out };
}
