/**
 * types.ts —— 与 domain 工具输出对齐的数据形状（壳只声明不推导）。
 */
export interface SceneNode {
  type: 'scene';
  title: string;
  /** 章文件内 1 起始行号。 */
  line: number;
}

export interface ChapterNode {
  type: 'chapter';
  title: string;
  relPath: string;
  status?: string;
  wordCount: number;
  scenes: SceneNode[];
  /** frontmatter id（uuid 稳定标识，B7 章稳定 id 关联；旧章可缺省）。 */
  id?: string;
  /** frontmatter goal（目标字数，B5；可缺省）。 */
  goal?: number;
  /** frontmatter blueprint（批一③ 碰撞放行标记）：'locked'=已放行、'draft'=碰撞进行中；其余不渲染徽标。 */
  blueprint?: string;
}

export interface VolumeNode {
  type: 'volume';
  title: string;
  children: ChapterNode[];
}

export interface ReadChapterResult {
  content: string;
  frontmatter: Record<string, unknown>;
  frontmatterRaw: string;
  body: string;
}

export interface SessionRow {
  id: string;
  title: string;
  /** 讨论归属：'' = 无归属；章 relPath = 章节内。 */
  scope: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
}

export type CandidateStatus = 'pending' | 'adopted' | 'discarded';

/** 候选动作类型：replace=锚定替换（现状）；append=追加章正文末尾；replace_all=替换整章正文。 */
export type CandidateKind = 'replace' | 'append' | 'replace_all';

/**
 * 回收站条目（list_trash 工具输出镜像，domain 并行开发以契约为准）。
 * 无时间戳的垃圾文件条目缺省 originalPath/deletedAt。
 */
export interface TrashEntry {
  /** 软删后 trash 副本路径（.novel/trash/<...>）。 */
  trashPath: string;
  kind: 'chapter' | 'volume';
  /** 原相对路径（章条目含 .md 后缀），找回时写回此路径；无时间戳垃圾文件缺省。 */
  originalPath?: string;
  /** 删除时间（ISO 串，列表新→旧排序）；无时间戳垃圾文件缺省。 */
  deletedAt?: string;
  /** 展示名（文件名）。 */
  name: string;
}

/** POST /v1/quality/check 的发现条目（契约镜像）：发布前章节风险提示（错别字/敏感词/用词不当）。 */
export interface QualityFinding {
  kind: 'typo' | 'sensitive' | 'wording' | 'other';
  /** 风险原文引用。 */
  quote: string;
  reason: string;
  suggestion?: string;
  /** 1 起始行号（含 frontmatter）。 */
  line?: number;
  /** 所在段的段首行号。 */
  paraLine?: number;
  /** false = LLM 给的 quote 没能在正文逐字定位（正常降级，行号不可信）。 */
  located?: boolean;
}

/** 暂存候选（AI 产出进暂存区，批量采纳才落地）。 */
export interface Candidate {
  id: string;
  sessionId: string | null;
  chapter: string;
  kind: CandidateKind;
  original: string;
  proposed: string;
  instruction: string;
  status: CandidateStatus;
  createdAt: string;
  updatedAt: string;
}