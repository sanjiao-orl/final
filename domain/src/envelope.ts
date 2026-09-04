/**
 * envelope.ts —— 统一事实信封（reference/05 §统一事实信封；4.1 地基批第一刀，纯加法）。
 *
 * 所有事实类型共享一个信封 {type, payload, 区间, 锚, 面}：
 * - payload = 按类型各自 schema（现有四维条目原样承载，不丢字段）；
 * - 区间 = 生效区间原语 {from, to|开放}（章 order 粒度；过期≠矛盾）；
 * - 锚 = evidence（chapter/line/quote）；账本锚为坐标权威（冲突入诊断，不在本模块裁决）；
 * - 面 = 冻结面/可补记面权限位（Letta 同构）。
 *
 * 双读纪律（reference/05 §兼容迁移）：ledgerToFacts → factsToLedger 对旧账本零 diff（round-trip
 * 断言见 tests/envelope.test.ts）；写入触及处按信封范式落笔以快照测试为闸门——本模块先落读路径
 * 归一化，写路径仍走既有 ledger 管线（模型层即日统一、文件层渐进收口）。
 */
import type { CharacterEntry, ClockRow, KnowledgeEntry, Ledger, LedgerOp, PropEntry, PromiseEntry } from './ledger.js';

/** 事实类型（有任务名的可增集合；「账本」正名后维度改称事实类型）。 */
export type FactType = 'clock' | 'prop' | 'promise' | 'knowledge' | 'character';

/** 生效区间（章 order 粒度；to=null 开放端=未闭合；过期≠矛盾）。 */
export interface FactInterval {
  /** 起始章 order（含）。 */
  from: number;
  /** 结束章 order（含）；null=开放端。 */
  to: number | null;
}

/** 证据锚（账本锚为坐标权威）。 */
export interface FactEvidence {
  chapter: string;
  line?: number;
  quote?: string;
}

/** 面权限位：frozen=冻结面（不得追加/改写）；appendable=可补记面。 */
export type FactFace = 'frozen' | 'appendable';

/** 统一事实信封。payload 为原条目（不丢字段），逆向投影 factsToLedger 原样还原。 */
export interface FactEnvelope {
  type: FactType;
  /** 自然键（promise=id / knowledge=character / prop=name / clock=chapters 序列化）。 */
  key: string;
  payload: unknown;
  interval: FactInterval;
  evidence: FactEvidence[];
  face: FactFace;
}

// ---------- 区间代数（确定性，独立测试） ----------

/** a 包含 b（b 完全落在 a 内；开放端视为 +∞）。 */
export function intervalContains(a: FactInterval, b: FactInterval): boolean {
  const aTo = a.to ?? Number.POSITIVE_INFINITY;
  const bTo = b.to ?? Number.POSITIVE_INFINITY;
  return a.from <= b.from && bTo <= aTo;
}

/** a 与 b 重叠（共享至少一章；开放端视为 +∞；相邻不算重叠）。 */
export function intervalsOverlap(a: FactInterval, b: FactInterval): boolean {
  const aTo = a.to ?? Number.POSITIVE_INFINITY;
  const bTo = b.to ?? Number.POSITIVE_INFINITY;
  return a.from <= bTo && b.from <= aTo;
}

/** 区间在 order 章生效（from ≤ order ≤ to；开放端=持续生效）。 */
export function intervalActiveAt(iv: FactInterval, order: number): boolean {
  return iv.from <= order && (iv.to === null || order <= iv.to);
}

/** 区间在 order 章已失效（闭合且 to < order；过期≠矛盾——失效只说明不再生效）。 */
export function intervalExpiredAt(iv: FactInterval, order: number): boolean {
  return iv.to !== null && order > iv.to;
}

// ---------- 双读归一化（ledger ⇄ envelopes） ----------

/** relPath → order 查找表（chapterOrder 缺项时按 relPath 内嵌数字兜底）。 */
function orderOf(chapterOrder: { relPath: string }[], relPath: string | undefined): number | null {
  if (!relPath) return null;
  const hit = chapterOrder.find((c) => c.relPath === relPath);
  if (hit) {
    const n = Number(String(hit.relPath).match(/(\d+)/)?.[1] ?? NaN);
    if (Number.isFinite(n)) return n;
    return 1;
  }
  const n = Number(relPath.match(/(\d+)/)?.[1] ?? NaN);
  return Number.isFinite(n) ? n : null;
}

function envelope(type: FactType, key: string, payload: unknown, from: number, to: number | null, evidence: FactEvidence[], face: FactFace): FactEnvelope {
  return { type, key, payload, interval: { from, to }, evidence, face };
}

function evidences(chapters: Array<string | { chapter: string; line?: number; quote?: string }>): FactEvidence[] {
  return chapters
    .filter(Boolean)
    .map((c) => {
      const e: FactEvidence = typeof c === 'string' ? { chapter: c } : { chapter: c.chapter };
      if (typeof c !== 'string') {
        if (c.line !== undefined) e.line = c.line;
        if (c.quote !== undefined) e.quote = c.quote;
      }
      return e;
    });
}

/**
 * ledgerToFacts：把任意（旧/新格式）账本归一化为信封集。
 * - clock：from=首章 order，to=末章 order（闭合跨度）；
 * - prop：from=托管链首步 order，to=null（开放——当前持有者持续生效）；
 * - promise：from=首个 setup order，to=末个 payoff order（resolved/failed 闭合）否则 null；
 * - knowledge：from=最早 knows[].since order，to=null（知情持续到被推翻，区间可后补）。
 * 章序缺项（orderOf=null）的条目：from 落 1（保守），evidence 原样保留。
 */
export function ledgerToFacts(ledger: Ledger, chapterOrder: { relPath: string; title?: string }[] = []): FactEnvelope[] {
  const facts: FactEnvelope[] = [];
  for (const row of ledger.clock) {
    const orders = row.chapters.map((c) => orderOf(chapterOrder, c)).filter((n): n is number => n !== null);
    const from = orders.length ? Math.min(...orders) : 1;
    const to = orders.length ? Math.max(...orders) : null;
    facts.push(envelope('clock', JSON.stringify(row.chapters), row, from, to, evidences(row.chapters), 'appendable'));
  }
  for (const p of ledger.props) {
    const orders = p.custody.map((c) => orderOf(chapterOrder, c.chapter)).filter((n): n is number => n !== null);
    facts.push(envelope('prop', p.name, p, orders.length ? Math.min(...orders) : 1, null, evidences(p.custody), 'appendable'));
  }
  for (const pr of ledger.promises) {
    const anchors = [...pr.setups, ...pr.payoffs];
    const orders = anchors.map((a) => orderOf(chapterOrder, a.chapter)).filter((n): n is number => n !== null);
    const closed = pr.arc === 'resolved' || pr.arc === 'failed';
    const pays = pr.payoffs.map((a) => orderOf(chapterOrder, a.chapter)).filter((n): n is number => n !== null);
    facts.push(
      envelope(
        'promise',
        pr.id,
        pr,
        orders.length ? Math.min(...orders) : 1,
        closed && pays.length ? Math.max(...pays) : null,
        evidences(anchors),
        closed ? 'frozen' : 'appendable',
      ),
    );
  }
  for (const k of ledger.knowledge) {
    const sinces = k.knows.map((f) => orderOf(chapterOrder, f.since)).filter((n): n is number => n !== null);
    const knowsEvi: Array<{ chapter: string; quote?: string }> = [];
    for (const f of k.knows) {
      if (typeof f.since !== 'string') continue;
      const ev: { chapter: string; quote?: string } = { chapter: f.since };
      if (typeof f.quote === 'string') ev.quote = f.quote;
      knowsEvi.push(ev);
    }
    facts.push(envelope('knowledge', k.character, k, sinces.length ? Math.min(...sinces) : 1, null, evidences(knowsEvi), 'appendable'));
  }
  // character（4.3 角色维，信封原生首型）：静态卡+动态 states 整卡一信封——from=最早状态 since（无状态=1 保守），to=null（卡持续生效）
  for (const c of ledger.characters ?? []) {
    const orders = (c.states ?? [])
      .map((s) => orderOf(chapterOrder, s.since))
      .filter((n): n is number => n !== null);
    const stateEvi: Array<{ chapter: string; line?: number; quote?: string }> = (c.states ?? [])
      .filter((s) => typeof s.since === 'string' && s.since !== '')
      .map((s) => {
        const ev: { chapter: string; line?: number; quote?: string } = { chapter: s.since };
        if (s.line !== undefined) ev.line = s.line;
        if (s.quote !== undefined) ev.quote = s.quote;
        return ev;
      });
    facts.push(envelope('character', c.name, c, orders.length ? Math.min(...orders) : 1, null, evidences(stateEvi), 'appendable'));
  }
  return facts;
}

/**
 * factsToLedger：信封集逆向投影回账本（payload 即原条目，原样还原）。
 * 区间/面/锚是信封层的导出视图，不回写条目（旧格式零 diff 的关键：投影无损）。
 * 三张登记表（doNotReexplain/protect/tripwires）不属事实信封，直传。
 */
export function factsToLedger(facts: FactEnvelope[], base: Ledger): Ledger {
  const out: Ledger = { ...base, clock: [], props: [], promises: [], knowledge: [] };
  const characters: CharacterEntry[] = [];
  let hasCharacters = false;
  for (const f of facts) {
    if (f.type === 'clock') out.clock.push(f.payload as ClockRow);
    else if (f.type === 'prop') out.props.push(f.payload as PropEntry);
    else if (f.type === 'promise') out.promises.push(f.payload as PromiseEntry);
    else if (f.type === 'knowledge') out.knowledge.push(f.payload as KnowledgeEntry);
    else if (f.type === 'character') {
      // character（4.3 信封原生首型）：仅当 facts 里真有角色卡才挂 characters 键——旧账本零 diff 的关键
      characters.push(f.payload as CharacterEntry);
      hasCharacters = true;
    }
  }
  if (hasCharacters || base.characters !== undefined) out.characters = characters;
  return out;
}

/** 双读零 diff 断言辅助：ledger → facts → ledger 深相等（测试与 4.1 快照闸门共用）。 */
export function dualReadRoundTrip(ledger: Ledger, chapterOrder: { relPath: string }[]): boolean {
  const back = factsToLedger(ledgerToFacts(ledger, chapterOrder), ledger);
  return JSON.stringify(back) === JSON.stringify(ledger);
}
