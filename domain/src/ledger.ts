/**
 * ledger.ts —— 四维账本（WS-9 结论 + T2 考古映射的 domain 落地）。
 *
 * 四维：时钟表 / 道具托管 / 承诺登记（=伏笔）/ 知情地图，结构 =「实体 + 状态字段 + 章节引用」。
 * 另含三张登记表：do-not-re-explain（不得重解释）、PROTECT（作者刻意设计，不报缺陷）、tripwire（高危硬规则）。
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
import { atomicWrite, assertWorkDir, collectMdFiles, resolveInside, toPosix } from './fsutil.js';
import { frontmatterEnd, parseFrontmatter } from './frontmatter.js';
import { loadPrompt } from './prompts.js';
import { SNAPSHOT_KEEP } from './tools.js';

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
}

/** 知情地图：一个角色的知情范围（T2 knowledge 轴 public/selective/secret）。 */
export interface KnowledgeEntry {
  character: string;
  /** 已知事实（事实描述）。 */
  knows: string[];
  /** 明确未知（作者登记，用于戏剧反讽判定）。 */
  doesNotKnow?: string[];
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
}

// ---------- 序列化：YAML frontmatter（机器态）+ Markdown 渲染（人读） ----------

/** 账本默认文件路径（相对 workDir）。 */
export const DEFAULT_LEDGER_PATH = '.novel/ledger.md';

/** 渲染时钟表为 Markdown 表格。 */
function renderClock(clock: ClockRow[]): string {
  if (clock.length === 0) return '_（空）_';
  const head = ['| Chapters | Thread | Story-day | Season | Absolute date | Notes |', '| --- | --- | --- | --- | --- | --- |'];
  const rows = clock.map((r) => {
    const esc = (s: string | undefined): string => (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    return `| ${r.chapters.map(esc).join(', ') || '-'} | ${esc(r.thread)} | ${esc(r.storyDay)} | ${esc(r.season)} | ${esc(r.absoluteDate)} | ${esc(r.notes)} |`;
  });
  return [head[0], head[1], ...rows].join('\n');
}

/** 渲染承诺登记。 */
function renderPromises(promises: PromiseEntry[]): string {
  if (promises.length === 0) return '_（空）_';
  return promises
    .map((p) => {
      const heat = p.heat ? ` [${p.heat}]` : '';
      const setups = p.setups.length > 0 ? p.setups.map((s) => `${s.chapter}${s.line ? `:${s.line}` : ''}`).join(', ') : '无';
      const payoffs = p.payoffs.length > 0 ? p.payoffs.map((x) => `${x.chapter}${x.line ? `:${x.line}` : ''}`).join(', ') : '无';
      const due = p.due !== undefined ? `，逾期：${p.due} 章` : '';
      return `- **${p.id}** [${p.arc}${heat}] ${p.name} — 埋设：${setups}；回收：${payoffs}${due}${p.note ? `（${p.note}）` : ''}`;
    })
    .join('\n');
}

/** 渲染道具托管。 */
function renderProps(props: PropEntry[]): string {
  if (props.length === 0) return '_（空）_';
  return props
    .map((p) => {
      const chain = p.custody.length > 0 ? p.custody.map((c) => `${c.holder ?? '?'}(${c.chapter}${c.line ? `:${c.line}` : ''})`).join(' → ') : '（无托管链）';
      return `- **${p.name}**${p.type ? ` [${p.type}]` : ''} — 当前：${p.holder ?? '?'}${p.status ? `（${p.status}）` : ''}；托管链：${chain}${p.tripwire ? `；硬规则：${p.tripwire}` : ''}`;
    })
    .join('\n');
}

/** 渲染知情地图。 */
function renderKnowledge(knowledge: KnowledgeEntry[]): string {
  if (knowledge.length === 0) return '_（空）_';
  return knowledge
    .map((k) => {
      const vis = k.visibility && k.visibility !== 'public' ? ` [${k.visibility}${k.knownBy ? `: ${k.knownBy.join(',')}` : ''}]` : '';
      const knows = k.knows.length > 0 ? k.knows.join('；') : '（无）';
      const dnk = k.doesNotKnow && k.doesNotKnow.length > 0 ? `；不知道：${k.doesNotKnow.join('；')}` : '';
      return `- **${k.character}**${vis} 知道：${knows}${dnk}`;
    })
    .join('\n');
}

/** 渲染整个账本为人类可读 Markdown（正文部分；frontmatter 由 writeLedger 单独写）。 */
export function renderLedgerMarkdown(ledger: Ledger): string {
  return [
    '# Reader Ledger',
    '',
    '> 四维账本（时钟表 / 道具托管 / 承诺登记 / 知情地图）+ 三张登记表。',
    '> 本文件由 domain 账本工具读写；机器态在顶部 YAML frontmatter，正文为渲染视图。',
    '',
    '## Position / Clock table',
    '',
    renderClock(ledger.clock),
    '',
    '## Promise register',
    '',
    renderPromises(ledger.promises),
    '',
    '## Prop custody',
    '',
    renderProps(ledger.props),
    '',
    '## Character knowledge-map',
    '',
    renderKnowledge(ledger.knowledge),
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
        return payoff;
      }),
    };
    const heat = str(o.heat);
    if (heat === 'HOT' || heat === 'WARM' || heat === 'COLD') promise.heat = heat;
    const due = num(o.due);
    if (due !== undefined) promise.due = due;
    const note = str(o.note);
    if (note !== undefined) promise.note = note;
    return promise;
  });
  base.knowledge = arr(r.knowledge).map((k): KnowledgeEntry => {
    const o = (k ?? {}) as Record<string, unknown>;
    const entry: KnowledgeEntry = { character: str(o.character) ?? '', knows: strArr(o.knows) };
    const doesNotKnow = strArr(o.doesNotKnow);
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

/** 账本序列化为完整文件内容（YAML frontmatter + 渲染正文）；未知字段（extra）原样写回，与已知字段冲突时已知字段优先。 */
export function serializeLedger(ledger: Ledger): string {
  const yaml = stringifyYaml(
    {
      ...(ledger.extra ?? {}), // 未知字段先展开，已知字段后覆盖 → 冲突时已知字段优先
      clock: ledger.clock,
      props: ledger.props,
      promises: ledger.promises,
      knowledge: ledger.knowledge,
      doNotReexplain: ledger.doNotReexplain,
      protect: ledger.protect,
      tripwires: ledger.tripwires,
    },
    { lineWidth: 0 },
  );
  return `---\n${yaml}---\n\n${renderLedgerMarkdown(ledger)}`;
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

/** 写账本（原子写，覆盖前对旧账本快照进 .novel/history/）；返回 { ok, path, bytes }。 */
export function writeLedger(workDir: string, ledger: Ledger, ledgerPath?: string): { ok: true; path: string; bytes: number } {
  const wd = assertWorkDir(workDir);
  const rel = ledgerPath || DEFAULT_LEDGER_PATH;
  const abs = ledgerAbs(wd, rel);
  const content = serializeLedger(ledger);
  snapshotLedgerBeforeWrite(wd, rel, abs, content);
  const { bytes } = atomicWrite(abs, content);
  return { ok: true, path: rel, bytes };
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

/** 写前复核：文件状态与读时一致才放行；被其他进程改动（存在性/mtimeMs/内容摘要任一变化）则抛错且不写入。 */
function assertLedgerUnchanged(abs: string, before: { exists: boolean; mtimeMs: number; content: string }): void {
  const now = ledgerFileState(abs);
  if (now.exists !== before.exists || now.mtimeMs !== before.mtimeMs || now.content !== before.content) {
    throw new Error('账本已被其他进程修改，请重读后再试');
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

/** 章节顺序（用于「逾期」章距计算；顺序即结构树阅读顺序）。 */
export type ChapterRef = { relPath: string; title: string };

/**
 * 账本级诊断（纯函数，不读文件）：悬空伏笔、逾期伏笔、道具双位冲突。
 * chapterOrder 为全书章顺序（用于逾期章距）。
 */
export function ledgerDiagnostics(ledger: Ledger, chapterOrder: ChapterRef[] = []): LedgerFinding[] {
  const findings: LedgerFinding[] = [];
  const orderIndex = new Map(chapterOrder.map((c, i) => [c.relPath, i]));
  const titleOf = (rel: string): string => chapterOrder.find((c) => c.relPath === rel)?.title ?? rel;

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
  '- 逐条以 CR 格式追加进 issues.md，并更新账本全部区块；',
  '- 只依据本章正文 + 账本状态判断，不臆造；',
  '- 严禁读取/注入本书其他章节全文。',
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
): { workDir: string; chapterRelPath: string; slice: string; injectedChapters: string[] } {
  const wd = assertWorkDir(workDir);
  const { ledger } = readLedger(wd, ledgerPath);

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

  // 问题日志尾部（WS-9：最后约 40 行；守卫：白名单 .novel/ 根下 .md 或 editorial_notes/ 下 .md，其余一律抛错）
  let issueTail = '';
  if (issueLogPath) {
    const issueAbs = assertLedgerMetaPath(wd, issueLogPath, 'issueLog'); // 越界/白名单外在此抛错
    try {
      const issueContent = fs.readFileSync(issueAbs, 'utf8');
      const lines = issueContent.split(/\r?\n/);
      issueTail = lines.slice(-40).join('\n');
    } catch {
      issueTail = '（问题日志不存在或不可读）';
    }
  }

  const template = coldReadSliceTemplate();
  // 单趟替换四个占位符（一次扫描，替换结果不再被扫描）：避免「正文/标题/日志尾部」这类用户可控文本里
  // 恰好含其它占位 token 时被后续 replaceAll 二次替换、混入审阅输入。
  const slice = template.replace(
    /\{\{账本切片\}\}|\{\{章节标题\}\}|\{\{章节内容\}\}|\{\{问题日志尾部\}\}/g,
    (token) => {
      switch (token) {
        case '{{账本切片}}':
          return renderLedgerMarkdown(ledger);
        case '{{章节标题}}':
          return title;
        case '{{章节内容}}':
          return body.trim();
        default:
          return issueTail || '（无）';
      }
    }
  );

  return { workDir: wd, chapterRelPath, slice, injectedChapters: [chapterRelPath] };
}

// ---------- 全作品诊断编排（读账本 + 逐章正文） ----------

export interface WorkDiagnostics {
  workDir: string;
  findings: LedgerFinding[];
  /** 是否存在 BLOCKER 级发现（确定性诊断 BLOCKER + 问题日志 BLOCKER 计数），供暂存区入口标红提示；不做硬拦截。 */
  hasBlockers: boolean;
  /** 问题日志（issues.md，CR 格式）里 severity 列为 BLOCKER 的条数；未提供 issueLogPath 或日志缺失时为 0。 */
  blockerCount: number;
}

/**
 * 对 workDir 跑全量确定性诊断：账本级（悬空/逾期/双位）+ 章级（章首跳变/季节冲突），
 * 并把问题日志（issues.md，CR 格式）的 BLOCKER 计数（severity 列判定）折叠进 hasBlockers——
 * 冷读产出的 BLOCKER 条目由本函数统一汇总，接进「暂存区入口标红提示」出口。
 */
export function diagnosticsForWork(workDir: string, ledgerPath?: string, issueLogPath?: string): WorkDiagnostics {
  const wd = assertWorkDir(workDir);
  const { ledger } = readLedger(wd, ledgerPath);

  const files = collectMdFiles(path.join(wd, 'manuscript'));
  const chapterOrder: ChapterRef[] = [];
  const bodies: Array<{ relPath: string; title: string; body: string }> = [];
  for (const f of files) {
    let content: string;
    try {
      content = fs.readFileSync(f.abs, 'utf8');
    } catch {
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
  return { workDir: wd, findings, hasBlockers, blockerCount };
}

// ---------- BLOCKER 清零提示出口 ----------

/**
 * 解析 issue 日志（CR 格式：`|` 分隔列）里 BLOCKER 条数：只看第 3 个字段（severity 列）恰为 BLOCKER 的行。
 * 不按行内任意位置的 "| BLOCKER |" 子串匹配——quote/why 字段含同样片段会多计。
 */
export function countBlockers(issueLogContent: string): { blockers: number; hasBlockers: boolean } {
  let n = 0;
  for (const line of issueLogContent.split(/\r?\n/)) {
    const fields = line.split('|').map((f) => f.trim());
    if (fields.length >= 3 && fields[2] === 'BLOCKER') n += 1;
  }
  return { blockers: n, hasBlockers: n > 0 };
}
