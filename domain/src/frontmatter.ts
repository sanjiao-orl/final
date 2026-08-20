/**
 * frontmatter.ts —— 章首简单 YAML 子集解析（title/status/pov/tags/synopsis/id/goal）。
 * 缺失或残缺一律容忍：解析失败视为无 frontmatter，返回空对象。
 */
import { parse as parseYaml } from 'yaml';

export interface Frontmatter {
  title?: string;
  status?: string;
  pov?: string;
  /** 字符串或字符串数组（YAML 两种写法都常见）。 */
  tags?: string | string[];
  synopsis?: string;
  /** 章唯一标识（非空 string 才收）。 */
  id?: string;
  /** 本章目标字数（number 取整数；string 能 parseInt 成正整数才收，否则忽略）。 */
  goal?: number;
  /** 本章蓝图碰撞模式（none/draft/locked；宽容解析，字符串即收，无值域校验）。 */
  blueprint?: string;
}

const FM_KEYS = ['title', 'status', 'pov', 'tags', 'synopsis', 'id', 'goal', 'blueprint'] as const;

/** 匹配文件开头的 `---` 包裹块，闭合行也可以是 `...`（YAML 规范）。 */
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/;

/** 解析 frontmatter；没有匹配块或 YAML 非法时返回空对象。 */
export function parseFrontmatter(content: string): Frontmatter {
  const m = FM_RE.exec(content);
  if (!m) return {};
  let raw: unknown;
  try {
    raw = parseYaml(m[1] ?? '');
  } catch {
    return {}; // 残缺/非法 YAML 容忍
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const out: Frontmatter = {};
  for (const key of FM_KEYS) {
    const v = record[key];
    if (key === 'goal') {
      // goal：number 取整数；string 能 parseInt 成正整数才收，否则忽略
      if (typeof v === 'number' && Number.isFinite(v)) {
        out.goal = Math.trunc(v);
      } else if (typeof v === 'string' && v.trim() !== '') {
        const n = Number.parseInt(v.trim(), 10);
        if (Number.isInteger(n) && n > 0) out.goal = n;
      }
    } else if (typeof v === 'string' && v.trim() !== '') {
      out[key] = v;
    } else if (key === 'tags' && Array.isArray(v)) {
      const tags = v.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
      if (tags.length > 0) out.tags = tags;
    }
  }
  return out;
}

/** 正文起始的字符偏移（frontmatter 块含闭合行一起跳过），无 frontmatter 时为 0。 */
export function frontmatterEnd(content: string): number {
  const m = FM_RE.exec(content);
  return m ? m[0].length : 0;
}
