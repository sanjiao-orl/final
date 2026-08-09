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

/** 暂存候选（AI 产出进暂存区，批量采纳才落地）。 */
export interface Candidate {
  id: string;
  sessionId: string | null;
  chapter: string;
  original: string;
  proposed: string;
  instruction: string;
  status: CandidateStatus;
  createdAt: string;
  updatedAt: string;
}