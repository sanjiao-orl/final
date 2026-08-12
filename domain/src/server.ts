/**
 * server.ts —— MCP stdio server 装配：注册十五个工具并连接 stdio transport。
 * 被 core 包经 MCP stdio spawn 调用；工具实现见 tools.ts。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  createChapter,
  createVolume,
  deleteChapter,
  exportTxt,
  listSnapshots,
  listStructure,
  moveChapter,
  moveVolume,
  readChapter,
  readSnapshot,
  renameChapter,
  renameVolume,
  searchContent,
  wordCount,
  writeChapter,
} from './tools.js';

const server = new McpServer({
  name: 'domain',
  version: '0.1.0',
});

/** 工具结果统一序列化为 JSON 文本。 */
function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

server.registerTool(
  'list_structure',
  {
    title: '列出作品结构树',
    description:
      '返回 workDir/manuscript 下的卷/章/场树：卷=子目录，章=.md 文件（frontmatter+正文），场=章内 ### 三级标题。结构永远从文件内容派生。',
    inputSchema: { workDir: z.string().describe('作品文件夹的绝对路径') },
  },
  async ({ workDir }) => jsonResult(listStructure(workDir)),
);

server.registerTool(
  'read_chapter',
  {
    title: '读取一章',
    description:
      '读取 workDir 内 relPath 指向的文件，返回原文 content（含 frontmatter）与解析出的 frontmatter。relPath 必须解析后仍在 workDir 内。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      relPath: z.string().describe('相对 workDir 的文件路径，如 manuscript/卷一/第一章.md'),
    },
  },
  async ({ workDir, relPath }) => jsonResult(readChapter(workDir, relPath)),
);

server.registerTool(
  'write_chapter',
  {
    title: '原子写入一章',
    description:
      '把 content 原子写入 workDir 内 relPath（同目录临时文件+rename），父目录自动创建；只允许 .md 后缀。返回 { ok, bytes }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      relPath: z.string().describe('相对 workDir 的目标路径，必须以 .md 结尾'),
      content: z.string().describe('章文件完整内容（可含 frontmatter）'),
    },
  },
  async ({ workDir, relPath, content }) => jsonResult(writeChapter(workDir, relPath, content)),
);

server.registerTool(
  'search_content',
  {
    title: '搜索正文',
    description:
      '在 manuscript/**/*.md 内做大小写不敏感子串匹配，返回 { relPath, line, excerpt }（excerpt 前后各 30 字截断），默认最多 20 条。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      query: z.string().describe('要搜索的子串（大小写不敏感）'),
      limit: z.number().int().positive().default(20).describe('最多返回条数，默认 20'),
    },
  },
  async ({ workDir, query, limit }) => jsonResult(searchContent(workDir, query, limit)),
);

server.registerTool(
  'word_count',
  {
    title: '统计字数',
    description:
      '统计字数（口径：非空白字符，中文写作惯例，不含 frontmatter）。给 relPath 只算该章；不给则汇总全 manuscript 并附每章明细。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      relPath: z.string().optional().describe('可选：相对 workDir 的章文件路径'),
    },
  },
  async ({ workDir, relPath }) => jsonResult(wordCount(workDir, relPath)),
);

server.registerTool(
  'delete_chapter',
  {
    title: '软删一章',
    description:
      '安全阀：把 manuscript/ 内的 .md 移进 .novel/trash/（时间戳防重名），永不物理删除。返回 { ok, trashPath }；从 trash 移回原路径即找回。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      relPath: z.string().describe('相对 workDir 的章文件路径，必须是 manuscript/ 内的 .md'),
    },
  },
  async ({ workDir, relPath }) => jsonResult(deleteChapter(workDir, relPath)),
);

server.registerTool(
  'export_txt',
  {
    title: '全稿导出 txt',
    description:
      '安全阀：按结构树顺序（卷→章）合并全稿为一个可直接投出的 txt——去 frontmatter、场景标题去 ### 标记。固定写到 workDir 根目录 全稿-<时间戳>.txt，返回 { ok, path, chapters, bytes }。',
    inputSchema: { workDir: z.string().describe('作品文件夹的绝对路径') },
  },
  async ({ workDir }) => jsonResult(exportTxt(workDir)),
);

server.registerTool(
  'create_chapter',
  {
    title: '新建一章',
    description:
      '在 manuscript 下新建 第N章·标题.md（volume 省略/空串时为散章），编号=卷内（或根）已匹配「第N章」模式的最大编号+1。frontmatter 模板含 title/status/id，goal 传了才写；volume 不能带路径分隔符、title 不能带编号前缀，同名文件已存在则抛错（不覆盖）。返回 { ok, relPath }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      volume: z.string().optional().describe('可选：manuscript 下的卷目录名，如 第一卷·风起；省略为散章'),
      title: z.string().optional().describe('可选：章的用户标题部分（不含编号），默认 新章'),
      goal: z.number().int().positive().optional().describe('可选：本章目标字数，写入 frontmatter 的 goal 字段'),
    },
  },
  async ({ workDir, volume, title, goal }) => jsonResult(createChapter(workDir, volume, title, goal)),
);

server.registerTool(
  'create_volume',
  {
    title: '新建一卷',
    description:
      '在 manuscript 下新建 第N卷·标题 目录，编号=直接子目录已匹配「第N卷」模式的最大编号+1。title 默认 新卷，不能带路径分隔符或编号前缀；同名卷目录已存在则抛错。返回 { ok, volumePath }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      title: z.string().optional().describe('可选：卷标题（不含编号），默认 新卷'),
    },
  },
  async ({ workDir, title }) => jsonResult(createVolume(workDir, title)),
);

server.registerTool(
  'rename_chapter',
  {
    title: '章改名',
    description:
      'relPath 必须是 manuscript/ 内的 .md（路径守卫同 delete_chapter）；原文件名匹配「第N章·标题」时保留编号只换标题，不匹配则直接用新标题。同步 frontmatter 的 title 行（无则插入/补建），其余字段与正文不动；目标同名已存在则抛错。返回 { ok, relPath }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      relPath: z.string().describe('相对 workDir 的章文件路径，如 manuscript/第一卷/第2章·客栈.md'),
      title: z.string().describe('章的用户标题部分（不含编号），如 少年'),
    },
  },
  async ({ workDir, relPath, title }) => jsonResult(renameChapter(workDir, relPath, title)),
);

server.registerTool(
  'rename_volume',
  {
    title: '卷改名',
    description:
      'volumePath 为 manuscript/ 下的目录 relPath（拒绝等于 manuscript 本身或非 manuscript/ 前缀）；匹配「第N卷·标题」时保留编号只换标题，否则直接用新标题。目标同名目录已存在则抛错。返回 { ok, volumePath }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      volumePath: z.string().describe('相对 workDir 的卷目录路径，如 manuscript/第一卷·风起'),
      title: z.string().describe('卷标题（不含编号），如 云涌'),
    },
  },
  async ({ workDir, volumePath, title }) => jsonResult(renameVolume(workDir, volumePath, title)),
);

server.registerTool(
  'move_chapter',
  {
    title: '卷内重排章',
    description:
      '把 relPath 章移到同卷内第 toIndex 位（0 起始），事务化重编号：按最终顺序把匹配「第N章」模式的章改为 第1章..第N章，frontmatter title 同步；不匹配的章名不动。先校验目标名冲突（存在即整体拒绝、不改任何文件），执行失败逆序回滚。不支持跨卷移动（toIndex 越界抛错）。返回 { ok, renumbered }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      relPath: z.string().describe('相对 workDir 的章文件路径，必须是 manuscript/ 内的 .md'),
      toIndex: z.number().int().min(0).describe('目标位置（0 起始），须在卷内章数范围内'),
    },
  },
  async ({ workDir, relPath, toIndex }) => jsonResult(moveChapter(workDir, relPath, toIndex)),
);

server.registerTool(
  'move_volume',
  {
    title: '卷排序',
    description:
      '把 volumePath 卷移到 manuscript 下第 toIndex 位（0 起始），匹配「第N卷」模式的卷按最终顺序重编号为 第1卷..第N卷；不匹配的卷名不变但排序仍按文件名。事务化（目标名冲突整体拒绝，失败逆序回滚）。返回 { ok, renumbered }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      volumePath: z.string().describe('相对 workDir 的卷目录路径，必须是 manuscript 直接子目录'),
      toIndex: z.number().int().min(0).describe('目标位置（0 起始），须在卷数范围内'),
    },
  },
  async ({ workDir, volumePath, toIndex }) => jsonResult(moveVolume(workDir, volumePath, toIndex)),
);

server.registerTool(
  'list_snapshots',
  {
    title: '列出历史快照',
    description:
      '列 .novel/history/ 下的滚动快照（write_chapter 覆盖写前自动留存旧版）：给 relPath 返回该章 { snapshots: [{ path, timestamp }] }；不给则按章拍平目录分组 { snapshots: [{ chapterFlatten, files }] }。时间戳文件名倒序（新在前）；无 history 目录返回空数组，不抛错。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      relPath: z.string().optional().describe('可选：章文件路径，如 manuscript/第一卷/第1章·少年.md'),
    },
  },
  async ({ workDir, relPath }) => jsonResult(listSnapshots(workDir, relPath)),
);

server.registerTool(
  'read_snapshot',
  {
    title: '读取历史快照',
    description:
      '读 .novel/history/ 下的快照 .md 原文。snapshotPath 必须解析后仍在 workDir 内、以 .md 结尾且位于 .novel/history/ 下（防止任意文件读取）。返回 { ok, content }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      snapshotPath: z.string().describe('相对 workDir 的快照路径，如 .novel/history/manuscript__第一卷__第1章·少年/20240101-000000000-aa.md'),
    },
  },
  async ({ workDir, snapshotPath }) => jsonResult(readSnapshot(workDir, snapshotPath)),
);

// 挂起等待 stdio 上的 MCP 请求
await server.connect(new StdioServerTransport());
