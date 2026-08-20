/**
 * server.ts —— MCP stdio server 装配：注册三十个工具并连接 stdio transport。
 * 双侧合并口径：基础工具 8 个 + WS-9 scan_quality + A 组 8 工具 + WS-17 账本 4 工具 + 0008 skill_read 1 工具 + 0009 问题日志 2 工具（issue_append/issue_set_status）+ scheme_set_active 1 工具（激活/取消激活方案指针）。
 * 批三-3 新增 2 工具：ledger_chapter_slice（按章过滤的账本视图，只读）+ write_meta（书级元数据写入，不写账本/不写正文）。
 * 批一③ 碰撞模式 新增 3 工具：decision_append（裁决留痕追加）/ decision_tail（裁决留痕尾部只读）/ chapter_set_blueprint（章蓝图模式设置），并在 frontmatter 透出 blueprint、buildChapter 透传。
 * 被 core 包经 MCP stdio spawn 调用；工具实现见 tools.ts / ledger.ts。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  chapterSetBlueprint,
  createChapter,
  createVolume,
  deleteChapter,
  deleteVolume,
  exportTxt,
  listSnapshots,
  listStructure,
  moveChapter,
  moveVolume,
  readChapter,
  readSnapshot,
  renameChapter,
  renameVolume,
  scanQuality,
  searchContent,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_EXCERPT_CHARS,
  wordCount,
  writeChapter,
} from './tools.js';
import {
  DECISION_TAIL_DEFAULT_LIMIT,
  decisionAppend,
  decisionTail,
  diagnosticsForWork,
  ISSUE_LOG_TAIL_LINES,
  issueAppend,
  issueSetStatus,
  ledgerChapterSlice,
  ledgerSlice,
  readLedger,
  upsertLedger,
  writeMeta,
  type IssueFinding,
  type LedgerOp,
} from './ledger.js';
import { readSkillBody, schemeSetActive } from './prompts.js';
import domainPkg from '../package.json' with { type: 'json' };

const server = new McpServer({
  name: 'domain',
  version: domainPkg.version,
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
      '读取 workDir/manuscript/ 内的 .md 章文件，返回原文 content（含 frontmatter）与解析出的 frontmatter。relPath 必须解析后仍在 workDir 内且位于 manuscript/ 下；唯一例外是 .novel/trash/ 内的 .md 软删副本（供找回被删章节）。',
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
      '把 content 原子写入 workDir/manuscript/ 内的 relPath（同目录临时文件+rename），父目录自动创建；只允许 .md 后缀。仅限章正文——设定/伏笔/知情/道具托管/时间线用 ledger_upsert，书级元数据用 write_meta，禁止把设定、账本、笔记类内容写进章文件。返回 { ok, bytes }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      relPath: z.string().describe('相对 workDir 的目标路径，必须位于 manuscript/ 下且以 .md 结尾'),
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
      `在 manuscript/**/*.md 内做大小写不敏感子串匹配，返回 { relPath, line, excerpt }（excerpt 前后各 ${SEARCH_EXCERPT_CHARS} 字截断），默认最多 ${SEARCH_DEFAULT_LIMIT} 条。`,
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      query: z.string().describe('要搜索的子串（大小写不敏感）'),
      limit: z.number().int().positive().default(SEARCH_DEFAULT_LIMIT).describe(`最多返回条数，默认 ${SEARCH_DEFAULT_LIMIT}`),
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
  'delete_volume',
  {
    title: '软删一卷',
    description:
      '安全阀：软删一卷——manuscript/ 下的卷目录（含全部章）整体移进 .novel/trash/（时间戳防重名），永不物理删除。返回 { ok, trashPath }；从 trash 移回原路径即找回。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      volumePath: z.string().describe('相对 workDir 的卷目录路径，必须是 manuscript/ 下的目录'),
    },
  },
  async ({ workDir, volumePath }) => jsonResult(deleteVolume(workDir, volumePath)),
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

server.registerTool(
  'create_chapter',
  {
    title: '新建一章',
    description:
      '在 manuscript 下新建 第N章·标题.md（volume 省略/空串时为散章），编号=卷内（或根）已匹配「第N章」模式的最大编号+1。frontmatter 模板含 title/status/id，goal 传了才写；volume 不能带路径分隔符、title 不能带编号前缀，同名文件已存在则抛错（不覆盖）。新建章只承载章正文——严禁为设定/账本/笔记类内容新建章（设定用 ledger_upsert，书级元数据用 write_meta）。返回 { ok, relPath }。',
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

server.registerTool(
  'ledger_read',
  {
    title: '读取四维账本',
    description:
      '读取 workDir 下的账本（默认 .novel/ledger.md，可传 ledgerPath 覆盖；必须是 .novel/ 根目录正下的 .md，不含子目录）：四维 = 时钟表/道具托管/承诺登记(伏笔)/知情地图 + 三张登记表（do-not-re-explain/PROTECT/tripwire）。文件不存在返回空账本；文件存在但损坏（frontmatter 缺失或 YAML 非法）抛错。账本机器态在 YAML frontmatter，正文为渲染视图。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      ledgerPath: z.string().optional().describe('可选：账本文件相对 workDir 路径，必须是 .novel/ 根目录正下的 .md（不含子目录），默认 .novel/ledger.md'),
    },
  },
  async ({ workDir, ledgerPath }) => jsonResult(readLedger(workDir, ledgerPath)),
);

server.registerTool(
  'ledger_upsert',
  {
    title: '更新四维账本',
    description:
      '把一组操作应用到账本并原子写回（覆盖前旧账本自动快照进 .novel/history/；账本损坏时拒绝写入；写前复核账本未被其他进程改动，被改动则抛错不覆盖）。ops 元素按 op 区分：clock/prop/promise/knowledge（传 entry，按 chapters/name/id/character 键 upsert）、doNotReexplain/tripwire（传 item 去重追加）、protect（传 item 去重追加，可带 reason）、remove（按各维自然键删除：dimension 传 clock/prop/promise/knowledge/doNotReexplain/protect/tripwire，clock 再传 chapters 数组、prop 传 name、promise 传 id、knowledge 传 character、三张登记表传 item 文本精确匹配；找不到目标静默 no-op，幂等）。entry 结构：clock 需 chapters 非空字符串数组（可带 thread/storyDay/season/absoluteDate/notes）；prop 需 name + custody 数组（元素 {chapter, holder?}）；knowledge 需 character + knows 数组（元素可为字符串（纯事实）或 {fact, since?, refs?}，since=得知章 relPath 时间轴，refs=回指伏笔 id；可带 doesNotKnow/visibility/knownBy）；promise 需 id + name + setups 数组 + payoffs 数组（元素 {chapter, line?, quote?}），可带 due/note/heat/expectedVolume（预计回收卷）/links（{props?, characters?} 关联道具角色），arc 枚举 planted 埋设（缺省可不传）/pending 待回收/resolved 已回收/failed 断线。章引用（clock.chapters / prop.custody[].chapter / promise.setups[].chapter / promise.payoffs[].chapter）必须用 canonical `manuscript/卷/第N章.md` relPath（正斜杠），否则 overdue-promise 的章序匹配会失效。ledgerPath 必须是 .novel/ 根目录正下的 .md（不含子目录）。返回更新后账本与写结果。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      ops: z.array(z.record(z.string(), z.unknown())).describe('账本操作数组，每项须含字符串 op 字段'),
      ledgerPath: z.string().optional().describe('可选：账本文件相对 workDir 路径，必须是 .novel/ 根目录正下的 .md（不含子目录），默认 .novel/ledger.md'),
    },
  },
  async ({ workDir, ops, ledgerPath }) => jsonResult(upsertLedger(workDir, ops as unknown as LedgerOp[], ledgerPath)),
);

server.registerTool(
  'ledger_diagnostics',
  {
    title: '账本确定性诊断',
    description:
      '对 workDir 跑全量确定性诊断（零 LLM 成本，宁缺毋滥）：账本级 = 悬空伏笔 / 逾期伏笔 / 道具双位冲突 + 批三-2 三条新规则（clock-regression 时钟跨章倒退 / custody-chain-break 托管链断裂 / knowledge-no-knower 保密无知情人登记）；章级 = 章首时间跳变 / 季节冲突。返回 findings（code/chapter/severity/category/message）、hasBlockers（是否存在 BLOCKER）与 blockerCount（问题日志 CR 行 severity 列为 BLOCKER 的条数）——BLOCKER 计数已接进 hasBlockers，供暂存区入口标红，不做硬拦截。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      ledgerPath: z.string().optional().describe('可选：账本文件相对 workDir 路径，必须是 .novel/ 根目录正下的 .md（不含子目录），默认 .novel/ledger.md'),
      issueLogPath: z.string().optional().describe('可选：问题日志（issues.md，CR 格式）相对 workDir 路径，必须是 .novel/ 根下或 editorial_notes/ 下的 .md，用于统计 BLOCKER 条数'),
    },
  },
  async ({ workDir, ledgerPath, issueLogPath }) => jsonResult(diagnosticsForWork(workDir, ledgerPath, issueLogPath)),
);

server.registerTool(
  'ledger_slice',
  {
    title: '组装冷读输入（单章 + 账本切片）',
    description:
      '组装贵档模型冷读输入：读者契约摘要 + 账本切片 + 单章正文（唯一注入章）+ 问题日志尾部。纪律：绝不注入其他章全文（AGENTS.md 禁令），只注入当前章；chapterRelPath 必须是 manuscript/ 内的 .md，issueLogPath 必须是 .novel/ 根下或 editorial_notes/ 下的 .md（编辑笔记）。返回 { slice, injectedChapters }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      chapterRelPath: z.string().describe('当前审阅章相对 workDir 路径，必须是 manuscript/ 内的 .md，如 manuscript/卷一/第1章.md'),
      ledgerPath: z.string().optional().describe('可选：账本文件相对 workDir 路径，必须是 .novel/ 根目录正下的 .md（不含子目录）'),
      issueLogPath: z.string().optional().describe(`可选：问题日志相对 workDir 路径，必须是 .novel/ 根下或 editorial_notes/ 下的 .md（注入最后约 ${ISSUE_LOG_TAIL_LINES} 行作续读上下文）`),
    },
  },
  async ({ workDir, chapterRelPath, ledgerPath, issueLogPath }) =>
    jsonResult(ledgerSlice(workDir, chapterRelPath, ledgerPath, issueLogPath)),
);

// 批三-3：按章过滤的账本视图（只读，不注入全账本）
server.registerTool(
  'ledger_chapter_slice',
  {
    title: '按章过滤的账本视图',
    description:
      '返回按章过滤的账本视角（只读，不写账本、不注入全账本）——只保留截至本章已发生的信息：clock 只留当前及之前的章行（任一未来章行整行删）、props 托管链裁到当前章（链空则整条删）、promises 排除未来埋设（planted 在未来=规划泄露）与已完成回收（resolution 在过去=噪音，恰为当前章的回收章必留）、knowledge 排除未来得知（since 在未来删，refs 原样透传）；do-not-re-explain/PROTECT/tripwires/未知字段原样透传。chapterRelPath 必须是 manuscript/ 内的 .md；章在全书章序内才 found=true（否则返回空账本与空 slice）；ledgerPath 必须是 .novel/ 根目录正下的 .md（不含子目录）。返回 { workDir, chapterRelPath, found, chapterTitle, ledger, slice }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      chapterRelPath: z.string().describe('当前章相对 workDir 路径，必须是 manuscript/ 内的 .md，如 manuscript/卷一/第1章.md'),
      ledgerPath: z.string().optional().describe('可选：账本文件相对 workDir 路径，必须是 .novel/ 根目录正下的 .md（不含子目录），默认 .novel/ledger.md'),
    },
  },
  async ({ workDir, chapterRelPath, ledgerPath }) => jsonResult(ledgerChapterSlice(workDir, chapterRelPath, ledgerPath)),
);

// 批三-3：书级元数据写入（不写账本、不写 manuscript 正文）
server.registerTool(
  'write_meta',
  {
    title: '写入书级元数据文件',
    description:
      '把 content 原子写入 workDir/.novel/ 根目录下的书级元数据 .md 文件（如 .novel/style.md），写前对旧版本快照进 .novel/history/。边界：只允许 .novel/ 根目录正下的 .md（不含子目录，白名单化）；不写账本——目标已存在且内容能解析为账本时拒写（账本请用 ledger_upsert）；不写 manuscript 正文、不写问题日志与 .novel/ 子目录内文件。返回 { ok, path, bytes }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      relPath: z.string().describe('相对 workDir 的目标路径，必须是 .novel/ 根目录下的 .md（不含子目录），如 .novel/style.md'),
      content: z.string().describe('文件完整内容（书级元数据，可含 frontmatter）'),
    },
  },
  async ({ workDir, relPath, content }) => jsonResult(writeMeta(workDir, relPath, content)),
);

// 26→27：激活/取消激活方案指针（纯加法；可用集 = app 预置 <promptRoot>/schemes 与书级 .novel/schemes 的 frontmatter name 并集）
server.registerTool(
  'scheme_set_active',
  {
    title: '激活/取消激活写作方案',
    description:
      '把「激活方案」指针原子写入作品目录（.novel/active-scheme，单行=方案 frontmatter name），供读写正文前按方案选聘写作角色：name 非空时校验其属于可用方案集——app 预置 core/prompts/schemes/*.md 与书级 .novel/schemes/*.md 的 frontmatter name 并集（同名书级遮蔽 app 级），命中则原子写指针、未命中报错并列可用方案名；name 为空串则删除指针文件（不存在也幂等成功），回到默认不激活。路径固定 .novel/active-scheme，不接受任何路径参数，不做历史快照。返回 { ok, active }（active=激活的方案 name，未激活为 null）。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      name: z.string().describe('方案 frontmatter name；空串=删除激活指针、回到默认不激活'),
    },
  },
  async ({ workDir, name }) => jsonResult(schemeSetActive(workDir, name)),
);

server.registerTool(
  'issue_append',
  {
    title: '追加问题日志条目',
    description:
      '把 findings 追加进问题日志（默认 editorial_notes/issues.md，可传 issueLogPath 覆盖；必须是 .novel/ 根下或 editorial_notes/ 下的 .md）。编号 CR-NNN 扫现有 CR-(\\d+) 最大 +1 续号（3 位零填充）；quote 去引号 trim 后在 chapter（manuscript/ 内 relPath）里找首次出现行号定位 ch:line（文件实际行号含 frontmatter，与 search_content 同口径；chapter 不存在或 quote 找不到则写 ?）。CR 行 scope 列固定 `-`、status 列固定 open（0009 新增状态列）；why/suggestion 分列 why 与 fix，suggestion 缺则 fix 填 `-`；行内禁止换行，`|` 统一替换为空格。返回 { appended, ids, path }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      issueLogPath: z.string().optional().describe('可选：问题日志相对 workDir 路径，必须是 .novel/ 根下或 editorial_notes/ 下的 .md，默认 editorial_notes/issues.md'),
      findings: z
        .array(
          z.object({
            severity: z.enum(['BLOCKER', 'MAJOR', 'MODERATE', 'MINOR']).describe('严重度：BLOCKER/MAJOR/MODERATE/MINOR'),
            category: z
              .enum(['CONT', 'CANON', 'VOICE', 'CRAFT', 'STRUCT', 'PACE', 'REPEAT', 'META'])
              .optional()
              .describe('类别（缺省按 META）：CONT/CANON/VOICE/CRAFT/STRUCT/PACE/REPEAT/META'),
            quote: z.string().describe('原文引用（可带引号包裹，追加前会去引号 trim 后用于定位行号）'),
            why: z.string().describe('问题说明（why / reader-moment）'),
            suggestion: z.string().optional().describe('修复建议（对应 CR 行 fix 列；缺省填 -）'),
            chapter: z.string().describe('章节定位：manuscript/ 内 relPath（正斜杠），如 manuscript/卷一/第1章.md'),
          }),
        )
        .describe('待追加的问题条目数组'),
    },
  },
  async ({ workDir, issueLogPath, findings }) =>
    jsonResult(issueAppend(workDir, findings as unknown as IssueFinding[], issueLogPath)),
);

server.registerTool(
  'issue_set_status',
  {
    title: '改问题日志条目状态',
    description:
      '把 id（CR-NNN）所在行的 status 列改写为 open/done/known（0009 新增状态列）：有则替换、无则行尾追加；id 找不到抛错；同状态重复设置幂等成功。返回 { ok, id, status }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      issueLogPath: z.string().optional().describe('可选：问题日志相对 workDir 路径，必须是 .novel/ 根下或 editorial_notes/ 下的 .md，默认 editorial_notes/issues.md'),
      id: z.string().describe('问题条目 id，格式 CR-NNN（3 位数字零填充）'),
      status: z.enum(['open', 'done', 'known']).describe('目标状态：open 待处理 / done 已处理 / known 已知'),
    },
  },
  async ({ workDir, issueLogPath, id, status }) =>
    jsonResult(issueSetStatus(workDir, id, status as 'open' | 'done' | 'known', issueLogPath)),
);

// 批一③ 碰撞模式：裁决留痕追加（第 28 个工具；一行一条留痕，追加式）
server.registerTool(
  'decision_append',
  {
    title: '追加裁决留痕',
    description:
      '把一条裁决追加进 workDir/editorial_notes/decisions.md（可选 path 覆盖，但必须是 editorial_notes/ 下的 .md）。编号 D-NNN 扫现有 D-(\\d+) 最大 +1 续号（3 位零填充），日期由服务端取当天；行格式 `- D-NNN | 日期 | 议题 | 立场 | 裁决 | 理由 | 章1,章2`，chapters 缺省/空数组输出 `-`。字段内 | 与换行统一替换为空格；topic/stance/reason 非空校验、ruling 用枚举校验（采纳/驳回/搁置）。返回 { appended, id, path }。追加式留痕：推翻旧裁决请新增条目并引用原 D 编号，不改旧行。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      topic: z.string().describe('议题：决定要裁决的事项'),
      stance: z.string().describe('立场：本次裁决的倾向/论据'),
      ruling: z.enum(['采纳', '驳回', '搁置']).describe('裁决结论：采纳/驳回/搁置'),
      reason: z.string().describe('理由：作出该裁决的原因'),
      chapters: z.array(z.string()).optional().describe('可选：涉及的章（章名如「第三章」或 relPath），缺省/空数组输出 -'),
      path: z.string().optional().describe('可选：裁决留痕相对 workDir 路径，必须 editorial_notes/ 下的 .md，默认 editorial_notes/decisions.md'),
    },
  },
  async ({ workDir, topic, stance, ruling, reason, chapters, path }) =>
    jsonResult(
      decisionAppend(workDir, {
        topic,
        stance,
        ruling,
        reason,
        ...(chapters !== undefined ? { chapters } : {}),
        ...(path !== undefined ? { path } : {}),
      }),
    ),
);

// 批一③ 碰撞模式：裁决留痕尾部只读（第 29 个工具）
server.registerTool(
  'decision_tail',
  {
    title: '读取裁决留痕尾部',
    description:
      `只读 workDir/editorial_notes/decisions.md（path 固定，不开放）里所有「以 - D- 开头」的行：total = 总行数，默认取尾部 ${DECISION_TAIL_DEFAULT_LIMIT} 行（上限 100）。给 chapter 时先取含该子串的行（保持原顺序），不足 limit 从尾部（最新）往前补齐不重复的行，超过 limit 截断；返回的 lines 按文件原顺序（旧的在前）。文件不存在返回 { total: 0, lines: [] }，不抛错。`,
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      chapter: z.string().optional().describe('可选：过滤子串（章名如「第三章」或 relPath），只保留含该子串的行'),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .default(DECISION_TAIL_DEFAULT_LIMIT)
        .describe(`最多返回行数，默认 ${DECISION_TAIL_DEFAULT_LIMIT}，上限 100`),
    },
  },
  async ({ workDir, chapter, limit }) => jsonResult(decisionTail(workDir, chapter, limit)),
);

// 批一③ 碰撞模式：章蓝图模式设置（第 30 个工具）
server.registerTool(
  'chapter_set_blueprint',
  {
    title: '设置章蓝图碰撞模式',
    description:
      '设置（或删除）manuscript/ 内 .md 章 frontmatter 的 blueprint（蓝图碰撞模式 none/draft/locked）：有 fm 则改已有行、没有则在 fm 块内追加；无 fm 新建仅 title（文件名去后缀）/blueprint 的最小块再拼原正文；value=none 删除 blueprint 行（缺省即 none）。正文与其余字段字节级保留，覆盖写前旧内容滚入 .novel/history/。返回 { relPath, blueprint }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      relPath: z.string().describe('相对 workDir 的章文件路径，必须是 manuscript/ 内的 .md，如 manuscript/卷一/第一章.md'),
      value: z.enum(['none', 'draft', 'locked']).describe('目标蓝图模式：none 删除（缺省）/ draft 草稿碰撞 / locked 锁定'),
    },
  },
  async ({ workDir, relPath, value }) =>
    jsonResult(chapterSetBlueprint(workDir, relPath, value as 'none' | 'draft' | 'locked')),
);

server.registerTool(
  'skill_read',
  {
    title: '读取 skill 正文',
    description:
      '按 frontmatter name 查找 kind:skill 文件并返回正文：先在 <workDir>/.novel/skills/ 找（书级同名遮蔽 app 级），再在 app 提示词目录（NOVEL_PROMPT_DIR）找。用于按需执行写作 skill。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      name: z.string().describe('skill 的 frontmatter name（中文显示名）'),
    },
  },
  async ({ workDir, name }) => jsonResult({ ok: true, name, content: readSkillBody(workDir, name) }),
);

// 挂起等待 stdio 上的 MCP 请求
await server.connect(new StdioServerTransport());
