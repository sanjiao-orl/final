/**
 * server.ts —— MCP stdio server 装配：注册 46 个工具（38 基线+4.2 加法 4+4.3 加法 4）并连接 stdio transport。
 * 双侧合并口径：基础工具 8 个 + WS-9 scan_quality + A 组 8 工具 + WS-17 账本 4 工具 + 0008 skill_read 1 工具 + 0009 问题日志 2 工具（issue_append/issue_set_status）+ scheme_set_active 1 工具（激活/取消激活方案指针）。
 * 批三-3 新增 2 工具：ledger_chapter_slice（按章过滤的账本视图，只读）+ write_meta（书级元数据写入，不写账本/不写正文）。
 * 批一③ 碰撞模式 新增 3 工具：decision_append（裁决留痕追加）/ decision_tail（裁决留痕尾部只读）/ chapter_set_blueprint（章蓝图模式设置），并在 frontmatter 透出 blueprint、buildChapter 透传。
 * 块1 理解层供料 新增 4 工具：ledger_reconcile（证据锚对账）/ write_chapter_summary + read_chapter_summaries（章摘要导生缓存，机检字段首写冻结）/ list_trash（回收站收口）；ledger_diagnostics 输出并入节奏诊断（pacing-flat，加法）。
 * 块1 遗留缺陷修复 新增 1 工具：restore_trash（找回回收站条目 = move-back 移回原路径，trash 副本不再存在）。
 * 块2 声口批 新增 2 工具：read_style（声口档案全文读回，摘要只是投影）+ voice_fingerprint（声口指纹确定性度量与偏离对照），现共 38 个工具。
 * 块4.1/4.2 新增 4 工具：promise_prefilter（承诺伏笔确定性预筛）+ inbox_list / inbox_append / inbox_decide（统一裁决收件箱三件套），现共 42 个；ledger_slice 增可选 budget 入参（4.1 预算闸，缺省行为零变）。
 * 块4.3 新增 4 工具：character_upsert（角色卡静态层直写，拒收 states）/ character_list / character_prefilter（角色维确定性预筛）/ character_refs（人名字段可解析引用报告），现共 46 个。
 * 被 core 包经 MCP stdio spawn 调用；工具实现见 tools.ts / ledger.ts / reconcile.ts / summaries.ts / voice.ts。
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
  exportChapterText,
  exportTxt,
  listSnapshots,
  listStructure,
  listTrash,
  moveChapter,
  moveVolume,
  readChapter,
  readSnapshot,
  renameChapter,
  renameVolume,
  restoreTrash,
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
  assertNoDirectStateWrite,
  readLedger,
  readStyle,
  upsertLedger,
  writeMeta,
  chapterOrderForWork,
  type CharacterEntry,
  type IssueFinding,
  type LedgerOp,
} from './ledger.js';
import { promisePrefilter } from './promise-prefilter.js';
import { characterPrefilter } from './character-prefilter.js';
import { resolveNameRefs } from './character-norm.js';
import { inboxAdopt, inboxAppend, inboxDiscard, inboxList } from './inbox.js';
import { makeProposal } from './proposal.js';
import { readSkillBody, schemeSetActive } from './prompts.js';
import { reconcileLedger } from './reconcile.js';
import { pacingDiagnostics, readChapterSummaries, writeChapterSummary } from './summaries.js';
import { voiceFingerprint } from './voice.js';
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
  async ({ workDir }, extra) => jsonResult(listStructure(workDir, extra.signal)),
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
  async ({ workDir, query, limit }, extra) => {
    const result = searchContent(workDir, query, limit, extra.signal);
    const out = jsonResult([...result]);
    // 静默漏章改可见（0822排查）：skipped 是数组附加属性，JSON 序列化会丢，展开为独立文本块透出。
    if (result.skipped?.length) {
      out.content.push({
        type: 'text' as const,
        text: `⚠️ ${result.skipped.length} 个文件读取失败，未纳入搜索：${result.skipped.map((s) => `${s.path}（${s.reason}）`).join('；')}`,
      });
    }
    return out;
  },
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
  async ({ workDir, relPath }, extra) => jsonResult(wordCount(workDir, relPath, extra.signal)),
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
  async ({ workDir }, extra) => jsonResult(exportTxt(workDir, extra.signal)),
);

server.registerTool(
  'export_chapter_text',
  {
    title: '导出单章平台文本',
    description: '返回平台格式的单章文本（章标题+正文，frontmatter 与 ### 场景标记已处理），供复制到发布平台。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      relPath: z.string().describe('相对 workDir 的章文件路径，必须是 manuscript/ 内的 .md'),
    },
  },
  async ({ workDir, relPath }, extra) => jsonResult(exportChapterText(workDir, relPath, extra.signal)),
);

server.registerTool(
  'scan_quality',
  {
    title: '扫描去 AI 味量化指标（LAY）',
    description:
      '确定性扫描 manuscript 全部章（零 LLM 成本）：CJK 字数、破折号、"不是X是Y"句式、正文元话语、段落长度、AI 口水词、高频词候选、感叹号/粗口分布、场景；书级：场景轮换池、连续同场景、跨章模板段落。逐章读文件，不注入正文。',
    inputSchema: { workDir: z.string().describe('作品文件夹的绝对路径') },
  },
  async ({ workDir }, extra) => jsonResult(scanQuality(workDir, extra.signal)),
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
      '把一组操作应用到账本并原子写回（覆盖前旧账本自动快照进 .novel/history/；账本损坏时拒绝写入；写前复核账本未被其他进程改动，被改动则抛错不覆盖）。ops 元素按 op 区分：clock/prop/promise/knowledge（传 entry，按 chapters/name/id/character 键 upsert）、doNotReexplain/tripwire（传 item 去重追加）、protect（传 item 去重追加，可带 reason）、character（4.3 角色卡：传 entry{name,...}，按 name 键 upsert；带 states 时整体替换动态层）、remove（按各维自然键删除：dimension 传 clock/prop/promise/knowledge/character/doNotReexplain/protect/tripwire，clock 再传 chapters 数组、prop 传 name、promise 传 id、knowledge 传 character、三张登记表传 item 文本精确匹配；找不到目标静默 no-op，幂等）。entry 结构：clock 需 chapters 非空字符串数组（可带 thread/storyDay/season/absoluteDate/notes）；prop 需 name + custody 数组（元素 {chapter, holder?}）；knowledge 需 character + knows 数组（元素可为字符串（纯事实）或 {fact, since?, refs?}，since=得知章 relPath 时间轴，refs=回指伏笔 id；可带 doesNotKnow/visibility/knownBy）；promise 需 id + name + setups 数组 + payoffs 数组（元素 {chapter, line?, quote?}），可带 due/note/heat/expectedVolume（预计回收卷）/links（{props?, characters?} 关联道具角色），arc 枚举 planted 埋设（缺省可不传）/pending 待回收/resolved 已回收/failed 断线。章引用（clock.chapters / prop.custody[].chapter / promise.setups[].chapter / promise.payoffs[].chapter）必须用 canonical `manuscript/卷/第N章.md` relPath（正斜杠），否则 overdue-promise 的章序匹配会失效。边界：character op 携带 states 时拒绝直写——位置/生死/境界等动态层走裁决回路（提案经收件箱作者裁决后落账）。ledgerPath 必须是 .novel/ 根目录正下的 .md（不含子目录）。返回更新后账本与写结果。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      ops: z.array(z.record(z.string(), z.unknown())).describe('账本操作数组，每项须含字符串 op 字段'),
      ledgerPath: z.string().optional().describe('可选：账本文件相对 workDir 路径，必须是 .novel/ 根目录正下的 .md（不含子目录），默认 .novel/ledger.md'),
    },
  },
  async ({ workDir, ops, ledgerPath }) => {
    assertNoDirectStateWrite(ops as unknown as LedgerOp[]);
    return jsonResult(upsertLedger(workDir, ops as unknown as LedgerOp[], ledgerPath));
  },
);

server.registerTool(
  'ledger_diagnostics',
  {
    title: '账本确定性诊断',
    description:
      '对 workDir 跑全量确定性诊断（零 LLM 成本，宁缺毋滥）：账本级 = 悬空伏笔 / 逾期伏笔 / 道具双位冲突 + 批三-2 三条新规则（clock-regression 时钟跨章倒退 / custody-chain-break 托管链断裂 / knowledge-no-knower 保密无知情人登记）；章级 = 章首时间跳变 / 季节冲突；块1 并入章摘要节奏诊断 pacing-flat（连续 ≥5 章张力 ≤4，MODERATE/PACE，摘要缓存缺失/不足时静默不出）。返回 findings（code/chapter/severity/category/message）、hasBlockers（是否存在 BLOCKER）与 blockerCount（问题日志 CR 行 severity 列为 BLOCKER 的条数）——BLOCKER 计数已接进 hasBlockers，供暂存区入口标红，不做硬拦截。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      ledgerPath: z.string().optional().describe('可选：账本文件相对 workDir 路径，必须是 .novel/ 根目录正下的 .md（不含子目录），默认 .novel/ledger.md'),
      issueLogPath: z.string().optional().describe('可选：问题日志（issues.md，CR 格式）相对 workDir 路径，必须是 .novel/ 根下或 editorial_notes/ 下的 .md，用于统计 BLOCKER 条数'),
    },
  },
  async ({ workDir, ledgerPath, issueLogPath }, extra) => {
    const base = diagnosticsForWork(workDir, ledgerPath, issueLogPath, extra.signal);
    // 块1：节奏诊断（章摘要 tension 机检字段）并入诊断输出——纯加法，pacing 永不产 BLOCKER，
    // hasBlockers/blockerCount 口径不受影响。
    const pacing = pacingDiagnostics(workDir);
    return jsonResult(pacing.length > 0 ? { ...base, findings: [...base.findings, ...pacing] } : base);
  },
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
      budget: z.number().int().positive().optional().describe('可选：账本切片字符预算（4.1 冷读预算闸）。传入时账本切片走索引层按生效区间+类型配额裁剪压进预算，返回附 ledgerSliceChars/Composition 注入构成；缺省=全量账本渲染（原行为）'),
    },
  },
  async ({ workDir, chapterRelPath, ledgerPath, issueLogPath, budget }) =>
    jsonResult(ledgerSlice(workDir, chapterRelPath, ledgerPath, issueLogPath, budget !== undefined ? { budget } : undefined)),
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

// 4.2 薄切片裁决回路（承诺·伏笔窄域）：预筛 + 收件箱三件（契约只加法）
server.registerTool(
  'promise_prefilter',
  {
    title: '承诺伏笔确定性预筛',
    description:
      '零 LLM 确定性预筛（承诺·伏笔窄域）：正文嫌疑句式（承诺/约定/欠偿类谓词）× 账本已登记承诺对照，返回每章嫌疑清单（行号/触发句/命中谓词/关联的已登记承诺 id）；命中但无账本关联的标「未登记候选」（超域规约：显式存在，不静默丢弃）。预筛只产候选不产提案——LLM 发现与提案生成在 core 扫描管线，裁决在收件箱。chapterRelPaths 缺省=全部章序。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      chapterRelPaths: z.array(z.string()).optional().describe('可选：限定预筛章（manuscript/ 内 .md）；缺省=全部章序'),
      ledgerPath: z.string().optional().describe('可选：账本文件相对 workDir 路径，必须是 .novel/ 根目录正下的 .md'),
    },
  },
  async ({ workDir, chapterRelPaths, ledgerPath }) => {
    const { ledger } = readLedger(workDir, ledgerPath);
    const chapterOrder = chapterOrderForWork(workDir);
    return jsonResult(promisePrefilter(workDir, { chapterRelPaths, ledger, chapterOrder }));
  },
);

// 4.3 角色卡批：角色维（信封原生首型）。静态层=登记型直写（character_upsert 拒收 states）；
// 动态层 states 走裁决回路（提案经 inbox_decide 采纳才落账）；预筛/引用报告=确定性零 LLM。
server.registerTool(
  'character_upsert',
  {
    title: '登记/更新角色卡（静态层直写）',
    description:
      '把角色卡静态层直写进账本 characters 表（name 键 upsert，走 upsert_ledger 的 CAS/快照管线）：name/aliases/kind（character|faction|location|lore，缺省 character）/role/faction/description/relations。设定登记（境界名/功法名/势力/地名）复用同模式。边界：states 字段被忽略（未传的动态字段自动保留既有值）——位置/生死/境界修为等动态状态是区间原生事实，只能经裁决回路写入（提案经收件箱作者裁决落账；ledger_upsert 直写带 states 会被拒绝），不做「当前值」直写。返回 {ledger, path, bytes}。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      entry: z
        .object({
          name: z.string().min(1),
          aliases: z.array(z.string().min(1)).optional(),
          kind: z.enum(['character', 'faction', 'location', 'lore']).optional(),
          role: z.string().optional(),
          faction: z.string().optional(),
          description: z.string().optional(),
          relations: z.string().optional(),
        })
        .describe('角色卡静态层条目'),
      ledgerPath: z.string().optional().describe('可选：账本文件相对 workDir 路径，必须是 .novel/ 根目录正下的 .md'),
    },
  },
  async ({ workDir, entry, ledgerPath }) => {
    const { ledger: before } = readLedger(workDir, ledgerPath);
    const prev = (before.characters ?? []).find((c) => c.name === entry.name);
    // 静态直写不改动态 states（它们不归直写管）；逐字段稀疏合并（exactOptionalPropertyTypes 下 undefined 不落键）
    const merged: CharacterEntry = {
      name: entry.name,
      ...(entry.aliases !== undefined ? { aliases: entry.aliases } : prev?.aliases !== undefined ? { aliases: prev.aliases } : {}),
      ...(entry.kind !== undefined ? { kind: entry.kind } : prev?.kind !== undefined ? { kind: prev.kind } : {}),
      ...(entry.role !== undefined ? { role: entry.role } : prev?.role !== undefined ? { role: prev.role } : {}),
      ...(entry.faction !== undefined ? { faction: entry.faction } : prev?.faction !== undefined ? { faction: prev.faction } : {}),
      ...(entry.description !== undefined ? { description: entry.description } : prev?.description !== undefined ? { description: prev.description } : {}),
      ...(entry.relations !== undefined ? { relations: entry.relations } : prev?.relations !== undefined ? { relations: prev.relations } : {}),
      ...(prev?.states !== undefined ? { states: prev.states } : {}),
    };
    return jsonResult(upsertLedger(workDir, [{ op: 'character', entry: merged }], ledgerPath));
  },
);

server.registerTool(
  'character_list',
  {
    title: '角色卡清单',
    description:
      '列出账本 characters 表（4.3 角色维静态层+动态 states）：全量或 kind 过滤；query 传名字/别名时走归一化精确匹配（含称谓形态）返回命中卡。返回 {count, characters}。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      kind: z.enum(['character', 'faction', 'location', 'lore']).optional().describe('可选：按登记种类过滤'),
      query: z.string().optional().describe('可选：名字/别名归一化查询（命中即只返回该卡）'),
      ledgerPath: z.string().optional().describe('可选：账本文件相对 workDir 路径，必须是 .novel/ 根目录正下的 .md'),
    },
  },
  async ({ workDir, kind, query, ledgerPath }) => {
    const { ledger } = readLedger(workDir, ledgerPath);
    let characters = ledger.characters ?? [];
    if (kind) characters = characters.filter((c) => (c.kind ?? 'character') === kind);
    if (query) {
      const { matchName } = await import('./character-norm.js');
      const hit = matchName(query, characters);
      characters = hit ? [hit.entry] : [];
    }
    return jsonResult({ count: characters.length, characters });
  },
);

server.registerTool(
  'character_prefilter',
  {
    title: '角色维确定性预筛',
    description:
      '零 LLM：正文扫描已知名/别名提及（词典+称谓形态归一）+ 超域疑似（高频未命中候选，count≥minCount 缺省 3——超域处置规约「不得静默丢弃」，由裁决回路定去留）+ 同一人多写法嫌疑（编辑距离 1）。返回 {scanned, mentions, unknownCandidates, variantSuspects}。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      chapterRelPaths: z.array(z.string()).optional().describe('可选：限定预筛章（manuscript/ 内 .md）；缺省=全部章序'),
      minCount: z.number().int().min(1).optional().describe('可选：超域疑似的高频门槛（缺省 3）'),
      ledgerPath: z.string().optional().describe('可选：账本文件相对 workDir 路径，必须是 .novel/ 根目录正下的 .md'),
    },
  },
  async ({ workDir, chapterRelPaths, minCount, ledgerPath }) => {
    const { ledger } = readLedger(workDir, ledgerPath);
    if ((ledger.characters ?? []).length === 0) {
      // 角色维未启用：不跑正文挖掘（否则超域疑似=全量高频功能词噪音），与 character_refs 的 enabled 闸同口径
      return jsonResult({ enabled: false, scanned: 0, mentions: [], unknownCandidates: [], variantSuspects: [] });
    }
    const chapterOrder = chapterOrderForWork(workDir);
    return jsonResult(characterPrefilter(workDir, { chapterRelPaths, ledger, chapterOrder, minCount }));
  },
);

server.registerTool(
  'character_refs',
  {
    title: '人名字段可解析引用报告',
    description:
      '把既有类型人名字段（promise.links.characters / knowledge.character / prop 持有人与托管链）对角色词典可选解析：未解析不报错只入清单（reference/05 §角色维）。characters 表为空=角色维未启用，返回 enabled:false 不产噪音。返回 {enabled, resolved, unresolved}。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      ledgerPath: z.string().optional().describe('可选：账本文件相对 workDir 路径，必须是 .novel/ 根目录正下的 .md'),
    },
  },
  async ({ workDir, ledgerPath }) => {
    const { ledger } = readLedger(workDir, ledgerPath);
    return jsonResult(resolveNameRefs(ledger));
  },
);

server.registerTool(
  'inbox_list',
  {
    title: '裁决收件箱列表',
    description:
      '统一裁决收件箱（reference/05：写入提案与预警=反向提案同箱同状态机）条目列表：id/origin/status/ops 摘由/裁决记录/回读验证。inboxPath 白名单=.novel/ 根下 .md，默认 .novel/inbox.md。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      inboxPath: z.string().optional().describe('可选：收件箱路径，必须是 .novel/ 根目录正下的 .md，默认 .novel/inbox.md'),
    },
  },
  async ({ workDir, inboxPath }) => {
    const entries = inboxList(workDir, inboxPath ?? undefined);
    return jsonResult({
      count: entries.length,
      pending: entries.filter((e) => e.proposal.status === 'pending').length,
      entries: entries.map((e) => ({
        id: e.proposal.id,
        origin: e.proposal.origin,
        status: e.proposal.status,
        createdAt: e.proposal.createdAt,
        ops: e.proposal.ops.map((o) => ({ action: o.action, targetKey: o.targetKey, rationale: o.rationale })),
        resolution: e.proposal.resolution ?? null,
        verify: e.verify ?? null,
      })),
    });
  },
);

server.registerTool(
  'inbox_append',
  {
    title: '提案入收件箱',
    description:
      '把扫描/预警产出的提案草稿写入统一裁决收件箱（作者裁决前不落账）。草稿={origin, ops[]}（ops 为 ProposalOp 形状：action/targetKey/op/evidence/rationale，入口做最小形状校验）；id 与 createdAt 由 domain 侧生成。幂等：pending 中同 (action,targetKey) 去重；「误报」裁决的键永久抑制再入；重叠键 op 级剔除（新候选不整提案静默丢）。返回 {added, skipped, outcomes}（outcomes 与草稿同序，逐份标记是否入箱，部分入箱带 skippedKeys 重叠明细）。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      drafts: z
        .array(
          z.object({
            origin: z.enum(['scan', 'chat', 'radar', 'import']),
            ops: z.array(
              z.object({
                action: z.enum(['ADD', 'UPDATE', 'DELETE', 'NOOP']),
                targetKey: z.string().min(1),
                op: z.object({ op: z.string() }).passthrough(),
                evidence: z.object({ chapter: z.string().min(1) }).passthrough().optional(),
                rationale: z.string().min(1),
              }),
            ),
          }),
        )
        .min(1)
        .describe('提案草稿数组'),
      inboxPath: z.string().optional().describe('可选：收件箱路径，必须是 .novel/ 根目录正下的 .md，默认 .novel/inbox.md'),
    },
  },
  async ({ workDir, drafts, inboxPath }) => {
    const proposals = drafts.map((d) => makeProposal(d.origin, d.ops as never));
    return jsonResult(inboxAppend(workDir, proposals, inboxPath ?? undefined));
  },
);

server.registerTool(
  'inbox_decide',
  {
    title: '裁决收件箱裁决',
    description:
      '对收件箱提案做作者裁决：decision=adopt（权限面复核→经 upsert_ledger 落账→回读验证目标条目在位/消失（修复过闸）→块置 adopted+验证结论）或 discard（必带理由枚举：误报/有意延后/已知情报/其他；有意延后可带 reanchorVolume 作卷锚重报依据）。返回裁决结果与验证消息。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      proposalId: z.string().describe('提案 id（inbox_list 返回）'),
      decision: z.enum(['adopt', 'discard']).describe('裁决：采纳（落账+回读验证）或驳回'),
      dismissReason: z.enum(['误报', '有意延后', '已知情报', '其他']).optional().describe('驳回必填理由枚举'),
      dismissNote: z.string().optional().describe('驳回备注'),
      reanchorVolume: z.string().optional().describe('有意延后时的新预计卷（卷锚重报依据）'),
      inboxPath: z.string().optional().describe('可选：收件箱路径，必须是 .novel/ 根目录正下的 .md'),
    },
  },
  async ({ workDir, proposalId, decision, dismissReason, dismissNote, reanchorVolume, inboxPath }) => {
    if (decision === 'adopt') {
      return jsonResult(inboxAdopt(workDir, proposalId, inboxPath ?? undefined));
    }
    if (!dismissReason) {
      return jsonResult({ isError: true, message: '驳回必带理由枚举（dismissReason）：误报/有意延后/已知情报/其他' });
    }
    return jsonResult(inboxDiscard(workDir, proposalId, { reason: dismissReason, ...(dismissNote ? { note: dismissNote } : {}), ...(reanchorVolume ? { reanchorVolume } : {}) }, inboxPath ?? undefined));
  },
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

/**
 * 裁决词表别名归一：碰撞协议（core/prompts/collide.md 等）用「放行|打回|搁置」，
 * 落盘规范词是「采纳/驳回/搁置」——登记时接受别名（放行→采纳、打回→驳回、搁置原样），
 * 归一后仍走原枚举校验，decisions.md 落盘的规范词不变。
 */
function normalizeRuling(v: unknown): unknown {
  if (v === '放行') return '采纳';
  if (v === '打回') return '驳回';
  return v;
}

server.registerTool(
  'decision_append',
  {
    title: '追加裁决留痕',
    description:
      '把一条裁决追加进 workDir/editorial_notes/decisions.md（可选 path 覆盖，但必须是 editorial_notes/ 下的 .md）。编号 D-NNN 扫现有 D-(\\d+) 最大 +1 续号（3 位零填充），日期由服务端取当天；行格式 `- D-NNN | 日期 | 议题 | 立场 | 裁决 | 理由 | 章1,章2`，chapters 缺省/空数组输出 `-`。字段内 | 与换行统一替换为空格；topic/stance/reason 非空校验、ruling 用枚举校验（采纳/驳回/搁置；也接受碰撞协议的 放行/打回，自动归一为 采纳/驳回 后落盘）。返回 { appended, id, path }。追加式留痕：推翻旧裁决请新增条目并引用原 D 编号，不改旧行。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      topic: z.string().describe('议题：决定要裁决的事项'),
      stance: z.string().describe('立场：本次裁决的倾向/论据'),
      ruling: z
        .preprocess(normalizeRuling, z.enum(['采纳', '驳回', '搁置']))
        .describe('裁决结论：采纳/驳回/搁置（登记时 放行/打回 也接受，自动归一为 采纳/驳回）'),
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

// 块1 理解层供料：证据锚对账器（第 32 个工具）
server.registerTool(
  'ledger_reconcile',
  {
    title: '账本证据锚对账',
    description:
      '对账器（确定性、零 LLM 成本、永不产 BLOCKER）：把四维账本里所有证据锚逐一回验正文——时钟表 chapters[] 每个章引用、道具托管链每步、伏笔 setups[]/payoffs[] 每条、知情事实的 since；锚 schema = chapter + 可选 line + 可选 quote（0013 决策3）。规则：锚指向的章不在当前章序 → anchor-chapter-missing（MAJOR/CONT，章被删/改名账本悬空）；有 quote 但在该章找不到 → anchor-quote-missing（MAJOR/CONT，账本抽错或正文已改）；quote 找到但行号与记录不符 → anchor-line-drift（MINOR/CONT，编辑漂移提示级）；无 quote 无 line 的纯章引用只验章存在性。返回 { workDir, anchors: { checked, ok, chapterMissing, quoteMissing, lineDrift }, findings, skipped? }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      ledgerPath: z.string().optional().describe('可选：账本文件相对 workDir 路径，必须是 .novel/ 根目录正下的 .md（不含子目录），默认 .novel/ledger.md'),
    },
  },
  async ({ workDir, ledgerPath }, extra) => jsonResult(reconcileLedger(workDir, ledgerPath, extra.signal)),
);

// 块1 理解层供料：章摘要导生缓存写入（第 33 个工具；机检字段首写冻结）
server.registerTool(
  'write_chapter_summary',
  {
    title: '写入章摘要缓存',
    description:
      '把单章摘要写入导生缓存 .novel/cache/chapter-summaries.json（可焚可重建，原子写）。校验：relPath 必须在当前章序内；summary 非空；tension 若给必须是 1-10 整数；wordCount 若给必须 ≥0 整数。冻结语义（0013 决策4）：tension/sceneType/wordCount 三机检字段随首次落盘冻结，重建（再次写入）只回改 summary 散文与 generatedAt，机检字段只在旧记录缺该字段时补写。返回 { ok, frozen }（frozen=true 表示传入机检字段因旧值已存在被冻结未更新）。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      relPath: z.string().describe('章相对 workDir 路径，必须是 manuscript/ 内且在章序内的 .md'),
      summary: z.string().describe('摘要散文（AI 生成，重建可改）'),
      tension: z.number().int().min(1).max(10).optional().describe('可选：张力 1-10（机检字段，首写冻结）'),
      sceneType: z.string().optional().describe('可选：场景类型（机检字段，首写冻结），如 战斗/日常/过渡/高潮/悬念/情感/其他'),
      wordCount: z.number().int().min(0).optional().describe('可选：字数（机检字段，首写冻结；非空白字符口径）'),
    },
  },
  async ({ workDir, relPath, summary, tension, sceneType, wordCount: wc }) =>
    jsonResult(
      writeChapterSummary(workDir, relPath, {
        summary,
        ...(tension !== undefined ? { tension } : {}),
        ...(sceneType !== undefined ? { sceneType } : {}),
        ...(wc !== undefined ? { wordCount: wc } : {}),
      }),
    ),
);

// 块1 理解层供料：章摘要导生缓存读取（第 34 个工具；before+limit 滚动多章为加法，契约不改动）
server.registerTool(
  'read_chapter_summaries',
  {
    title: '读取章摘要缓存',
    description:
      '读章摘要导生缓存（.novel/cache/chapter-summaries.json；可焚可重建，损坏按空缓存处理不抛错）。给 relPath 只返回该章（不在缓存→空数组）；给 before 返回章序中该章之前最近 N 章有摘要的记录（缺省 N=1 即最近一章；N 最大 10，按章序升序返回，供「滚动前章摘要」注入）；不给返回全部，按章序排，被删/改名的章标 stale:true 排最后。返回 { summaries: [{ relPath, summary, tension?, sceneType?, wordCount?, generatedAt, stale? }] }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      relPath: z.string().optional().describe('可选：章相对 workDir 路径'),
      before: z.string().optional().describe('可选：章相对 workDir 路径——给了就只返回章序中该章之前有摘要的记录（配合 limit 滚动多章，缺省只回最近一章）；与 relPath 同给时 before 优先'),
      limit: z.number().int().min(1).max(10).optional().describe('可选：before 模式下返回最近 N 章有摘要的记录（1-10，缺省 1，按章序升序）'),
    },
  },
  async ({ workDir, relPath, before, limit }) =>
    jsonResult(
      readChapterSummaries(
        workDir,
        relPath,
        before !== undefined ? { before, ...(limit !== undefined ? { limit } : {}) } : undefined,
      ),
    ),
);

// 块1：回收站收口进 domain（第 35 个工具；壳不再用 localStorage 跟踪软删）
server.registerTool(
  'list_trash',
  {
    title: '列出回收站',
    description:
      '列 .novel/trash/ 直接子项（不递归；目录不存在→空数组；只读）：每项 { trashPath, kind: chapter|volume, originalPath?, deletedAt?, name }——originalPath 从拍平文件名 best-effort 还原（章条目补回 .md 后缀；原名本身含 __ 的极端情形会失真），deletedAt 从文件名时间戳解析；无时间戳的垃圾文件名仍列出但无 originalPath/deletedAt。排序 deletedAt 新→旧。找回用 restore_trash（move-back 移回原路径，trash 副本不再存在）。',
    inputSchema: { workDir: z.string().describe('作品文件夹的绝对路径') },
  },
  async ({ workDir }) => jsonResult(listTrash(workDir)),
);

// 块1 遗留缺陷修复：找回闭环为 move-back（第 36 个工具；旧「读回写」会残留 trash 副本污染回收站）
server.registerTool(
  'restore_trash',
  {
    title: '找回回收站条目',
    description:
      '把 .novel/trash/ 正下的软删条目按文件名还原的原路径移回 manuscript/（同卷原子 rename，move-back）：移回后 trash 副本不再存在（回收站不残留）。文件名解析与 list_trash 同口径；无时间戳、无法还原原路径的垃圾条目抛错请手动处理；原路径必须 manuscript/ 开头；目标已存在拒绝（不覆盖，先处理冲突）。返回 { ok, restoredPath, kind }。',
    inputSchema: {
      workDir: z.string().describe('作品文件夹的绝对路径'),
      trashPath: z.string().describe('相对 workDir 的回收站条目路径，必须是 .novel/trash/ 正下的直接子项（来自 list_trash 的 trashPath）'),
    },
  },
  async ({ workDir, trashPath }) => jsonResult(restoreTrash(workDir, trashPath)),
);

// 块2·② 声口档案全文读回（第 37 个工具；系统提示的「## 声口摘要」只是 1500 字投影，本工具是事实源）
server.registerTool(
  'read_style',
  {
    title: '读书级声口档案全文',
    description:
      '读回 workDir/.novel/style.md 声口档案全文（六透镜+证据）。系统提示注入的「## 声口摘要」只是投影——需要细看声口时（建档前确认现状、续写/改写前对齐口径、怀疑摘要截断丢信息）读本文件。不存在返回 { exists: false }（= 尚未建档，可跑「声口建档」skill），不报错。',
    inputSchema: { workDir: z.string().describe('作品文件夹的绝对路径') },
  },
  async ({ workDir }) => jsonResult(readStyle(workDir)),
);

// 块2·③ 声口指纹确定性度量（第 38 个工具；句长/对白/段长/高频二字组，纯计算不涉 LLM，偏离提示作仪表不拦内容）
server.registerTool(
  'voice_fingerprint',
  {
    title: '声口指纹度量与偏离对照',
    description:
      '对章正文或内联文本计算声口量化指纹（句长分布/对白占比/段长/高频二字组），确定性计算。用途：①全书或逐章声口底数（缺省 relPaths/texts 时度量全书章，需 workDir）；②续写/改写产出对照（texts 给 [基线,产出] 两段，compare 指定下标）产出偏离提示 flags——作仪表不入门禁，样本 CJK 不足 100 字不出提示。',
    inputSchema: {
      workDir: z.string().optional().describe('作品文件夹的绝对路径（relPaths/全书模式必填；纯 texts 模式可省）'),
      relPaths: z.array(z.string()).optional().describe('manuscript/ 下章相对路径清单（缺省=全书章）'),
      texts: z.array(z.string().max(20_000)).max(4).optional().describe('内联文本样本（≤4 段，每段 ≤20000 字符；如改写原文与产出）'),
      compare: z
        .object({
          baselineIndex: z.number().int().min(0).describe('基线样本在 samples 数组的下标'),
          sampleIndex: z.number().int().min(0).describe('对照样本下标（relPaths 样本在前、texts 在后）'),
        })
        .optional()
        .describe('对照两份样本产出偏离提示（deltas+flags）'),
    },
  },
  async (input) => jsonResult(voiceFingerprint(input)),
);

// 挂起等待 stdio 上的 MCP 请求
await server.connect(new StdioServerTransport());
