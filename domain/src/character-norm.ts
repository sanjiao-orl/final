/**
 * character-norm.ts —— 角色维别名归一（reference/05 §角色维；4.3 角色卡批）。
 *
 * 归一口径（确定性，零 LLM）：别名表 + 词典精确匹配 + 同形词排除表 + 中文称谓规则。
 * 纪律：人名字段可解析引用=可选解析、不强制、未解析不报错只入诊断清单（resolveNameRefs）。
 * 只依赖 ledger.ts 类型（import type 防运行时环——ledger.ts 诊断反向引用本模块，ledger-index 同款反转）。
 */
import type { CharacterEntry, Ledger } from './ledger.js';

/** 中文称谓后缀（匹配形态展开时剥离：克莱恩先生→克莱恩；剥离后 <2 字不收，防「大人」整体词清空）。 */
const HONORIFIC_SUFFIXES = ['先生', '女士', '小姐', '夫人', '老爷', '阁下', '同学', '老师', '殿下', '陛下', '少爷', '姑娘', '小子'];
/** 中文称谓前缀（老/小/阿 + 名：老尼尔→尼尔，命中别名谱或本名）。 */
const HONORIFIC_PREFIXES = ['老', '小', '阿'];
/** 同形词排除表：归一化结果落在这里=不是人名引用（防称谓剥离后的普通词/泛称误配；书级可扩充——词表数据化挂缓做）。 */
const EXCLUDE_TABLE = new Set(['今日', '明日', '大人', '老爷', '天地', '天下', '长老', '大师', '父子', '姐妹', '兄弟', '二人', '三人']);

/** 名字归一：去空白/间隔点、小写。登记名保持原样入库，归一只发生在匹配形态层。 */
export function normalizeName(s: string): string {
  return String(s ?? '')
    .replace(/[\s·・]/g, '')
    .toLowerCase();
}

/** 一个名字的全部匹配形态：原名 + 称谓剥离/派生（词典精确匹配的查询键集；排除表过滤）。 */
export function nameVariants(raw: string): string[] {
  const out = new Set<string>();
  const base = normalizeName(raw);
  if (!base) return [];
  out.add(base);
  for (const suf of HONORIFIC_SUFFIXES) {
    if (base.endsWith(suf) && base.length - suf.length >= 2) out.add(base.slice(0, base.length - suf.length));
  }
  for (const pre of HONORIFIC_PREFIXES) {
    if (base.startsWith(pre) && base.length - 1 >= 2) out.add(base.slice(1));
  }
  return [...out].filter((x) => x.length >= 2 && !EXCLUDE_TABLE.has(x));
}

/** 词典精确匹配：名字/别名 → 命中条目（含称谓形态；同键先到先得=主名优先于别名）。 */
export function matchName(
  name: string,
  entries: CharacterEntry[],
): { entry: CharacterEntry; via: 'name' | 'alias'; matched: string } | null {
  if (entries.length === 0) return null;
  const dict = new Map<string, { entry: CharacterEntry; via: 'name' | 'alias' }>();
  for (const e of entries) {
    const n = normalizeName(e.name);
    if (n && !dict.has(n)) dict.set(n, { entry: e, via: 'name' });
    for (const a of e.aliases ?? []) {
      const an = normalizeName(a);
      if (an && !dict.has(an)) dict.set(an, { entry: e, via: 'alias' });
    }
  }
  for (const v of nameVariants(name)) {
    const hit = dict.get(v);
    if (hit) return { entry: hit.entry, via: hit.via, matched: v };
  }
  return null;
}

/**
 * 人名字段可解析引用报告（reference/05 §角色维：可选解析、不强制、未解析不报错只入清单）。
 * 既有类型人名字段=promise.links.characters / knowledge.character / prop（holder+托管链 holder）。
 * characters 表缺省/为空=角色维未启用 → enabled:false，不产噪音（未解析清单只在启用后有义）。
 */
export interface NameRefReport {
  enabled: boolean;
  resolved: number;
  unresolved: Array<{ where: string; name: string }>;
}

export function resolveNameRefs(ledger: Ledger): NameRefReport {
  const entries = ledger.characters ?? [];
  if (entries.length === 0) return { enabled: false, resolved: 0, unresolved: [] };
  const unresolved: NameRefReport['unresolved'] = [];
  let resolved = 0;
  const check = (where: string, name: string | undefined): void => {
    if (!name || name.trim() === '') return;
    if (matchName(name, entries)) resolved++;
    else unresolved.push({ where, name });
  };
  for (const p of ledger.promises) for (const c of p.links?.characters ?? []) check(`promise:${p.id}`, c);
  for (const k of ledger.knowledge) check(`knowledge:${k.character}`, k.character);
  for (const pr of ledger.props) {
    check(`prop:${pr.name}`, pr.holder);
    for (const c of pr.custody) check(`prop:${pr.name}`, c.holder);
  }
  return { enabled: true, resolved, unresolved };
}

/** 编辑距离 ≤1（同一人多写法判定：错字/多字/少字/换字各一位）。 */
function withinEditDistance1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  let j = 0;
  let diff = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++diff > 1) return false;
    if (la === lb) {
      i++;
      j++;
    } else if (la > lb) i++;
    else j++;
  }
  if (i < la || j < lb) diff++;
  return diff <= 1;
}

/** CJK 汉字（含扩展）判定：变体候选只从汉字串里取，避开标点/拉丁。 */
function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

function cjkRuns(text: string): string[] {
  const runs: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (isCjk(ch)) cur += ch;
    else if (cur) {
      runs.push(cur);
      cur = '';
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

export interface VariantSuspect {
  /** 未登记写法（正文中出现）。 */
  variant: string;
  /** 疑似指向的已登记名。 */
  likely: string;
  count: number;
}

/**
 * 同一人多写法检测（确定性诊断第二条）：正文中与已知名/别名编辑距离 ≤1 的未登记写法。
 * 频次由调用方口径定（1–2 次多为一次性称呼/错字——人审域，不在此拦）。
 */
export function samePersonVariants(text: string, entries: CharacterEntry[]): VariantSuspect[] {
  if (entries.length === 0 || !text) return [];
  const registered = new Set<string>();
  const names: string[] = [];
  for (const e of entries) {
    for (const n of [e.name, ...(e.aliases ?? [])]) {
      const nn = normalizeName(n);
      if (nn.length >= 2 && nn.length <= 4) {
        registered.add(nn);
        names.push(nn);
      }
    }
  }
  if (names.length === 0) return [];
  const counts = new Map<string, number>();
  for (const run of cjkRuns(text)) {
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i + len <= run.length; i++) {
        const token = run.slice(i, i + len);
        if (registered.has(token) || EXCLUDE_TABLE.has(token)) continue;
        for (const name of names) {
          if (withinEditDistance1(token, name)) {
            counts.set(token, (counts.get(token) ?? 0) + 1);
            break; // 一个 token 只记一次
          }
        }
      }
    }
  }
  return [...counts.entries()]
    .map(([variant, count]) => {
      const likely = names.find((name) => withinEditDistance1(variant, name)) ?? '';
      return { variant, likely, count };
    })
    .sort((a, b) => b.count - a.count || a.variant.localeCompare(b.variant));
}
