/**
 * server.ts —— MCP stdio server 装配：注册六个工具并连接 stdio transport。
 * 被 core 包经 MCP stdio spawn 调用；工具实现见 tools.ts。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  deleteChapter,
  exportTxt,
  listStructure,
  readChapter,
  scanQuality,
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
  'scan_quality',
  {
    title: '扫描去 AI 味量化指标（LAY）',
    description:
      '确定性扫描 manuscript 全部章（零 LLM 成本）：CJK 字数、破折号、"不是X是Y"句式、正文元话语、段落长度、AI 口水词、高频词候选、感叹号/粗口分布、场景；书级：场景轮换池、连续同场景、跨章模板段落。逐章读文件，不注入正文。',
    inputSchema: { workDir: z.string().describe('作品文件夹的绝对路径') },
  },
  async ({ workDir }) => jsonResult(scanQuality(workDir)),
);

// 挂起等待 stdio 上的 MCP 请求
await server.connect(new StdioServerTransport());
