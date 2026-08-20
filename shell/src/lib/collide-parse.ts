/**
 * collide-parse.ts —— 碰撞模式（批一③）的结构化输出解析。
 *
 * core 碰撞输出为纯 markdown 文本，按序含四个固定二级标题：
 *   ## 方案 / ## 漏洞 / ## 反方 / ## 裁决
 * 本函数做"认识才特殊渲染、不认识回退整泡"的容错解析：
 * 四节齐备且首次出现顺序正确 → 切成 4 段（含标题行）；否则返回 null（走普通 markdown 整渲）。
 */

export type CollideSec = '方案' | '漏洞' | '反方' | '裁决';

export interface CollideSection {
  sec: CollideSec;
  md: string;
}

/** 四节合法顺序（首次出现的 h2 标题）与每节应匹配的标题。 */
const ORDER: CollideSec[] = ['方案', '漏洞', '反方', '裁决'];

/** 行级 h2 标题匹配：`^##\s+(方案|漏洞|反方|裁决)\s*$`（容忍首尾空格）。 */
function h2Of(line: string): CollideSec | null {
  const m = /^##\s+(方案|漏洞|反方|裁决)\s*$/.exec(line);
  return m ? (m[1] as CollideSec) : null;
}

/** 任意 h2 标题（含不认识的）：用于把"多出一个陌生 h2"判为 null。 */
function isAnyH2(line: string): boolean {
  return /^##\s+\S/.test(line) || /^##\s*$/.test(line);
}

/**
 * 解析碰撞输出。判据：
 * - 逐行扫，收集 h2 标题位置；不认识的结构（陌生 h2 标题 / 四节不齐 / 顺序错乱）→ null；
 * - 四节齐备且首次出现顺序 = 方案→漏洞→反方→裁决 → 拆段：
 *   标题前的引导内容（若存在）并入第一段 md 开头；每段 = 其标题行到下一标题前的内容。
 */
export function collideParse(content: string): CollideSection[] | null {
  if (typeof content !== 'string') return null;
  if (content.trim() === '') return null;

  const lines = content.split(/\r?\n/);
  const heads: { line: number; sec: CollideSec }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s+/.test(line)) {
      const sec = h2Of(line);
      if (sec) {
        heads.push({ line: i, sec });
      } else if (isAnyH2(line)) {
        // 陌生 h2 标题：不认识的结构 → 回退普通渲染
        return null;
      }
    }
  }

  // 四节齐备且首次出现顺序必须严格 = ORDER
  if (heads.length !== ORDER.length) return null;
  for (let k = 0; k < ORDER.length; k++) {
    if (heads[k]!.sec !== ORDER[k]) return null;
  }

  const out: CollideSection[] = [];
  for (let k = 0; k < heads.length; k++) {
    const start = heads[k]!.line;
    const end = k + 1 < heads.length ? heads[k + 1]!.line : lines.length;
    let md = lines.slice(start, end).join('\n');
    // 引导内容并入第一段开头（标题行之前的所有行）
    if (k === 0 && start > 0) {
      md = lines.slice(0, start).join('\n') + '\n' + md;
    }
    out.push({ sec: heads[k]!.sec, md: md.trim() });
  }
  return out;
}
