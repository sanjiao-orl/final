# 0012 · chat 正文进暂存区（铁律回归）+ 候选 kind 扩展 + 设定路由

> 2026-08-17。起因：作者真实写作实报两处工作流走样——①AI 产出未进暂存区，对话讨论经作者同意后直接 write_chapter 落正文；②「思维账本」（账本/设定）内容被 AI 自行写进 manuscript 根下散章（结构树显示为「未分卷」）。逐层取证 core chat 链路 / 壳审批门 / 工具描述后定稿。

## 根因（代码实证）

- **chat 通道机制上无暂存入口**：正文唯一出口是 MCP 工具 `write_chapter`，core 在 streamText 循环内就地执行（`core/src/chat.ts`），壳审批门是「放行语义 + 拒绝补偿」（`shell/src/lib/approval.svelte.ts` 头注）——内容先落盘、卡才弹出，拒绝只能靠事前快照还原。
- **属决策 drift**：0005 落选区早已否决此形态（「AI 直接 write_chapter 改正文：绕过暂存区，违反铁律」）。0005 只给选区改写链（/rewrite → /candidates）建了暂存入口，chat 通道没有；批三-1 写 chat.md 工作流指引时把直写合法化。
- **设定污染**：chat.md 工作流指引未提账本工具（批三-1 早于批三-2/-3 的 ledger 工具落地），模型面对「记录设定」类请求只有 write/create 写入认知 → 设定写进 manuscript 散章；write_chapter/create_chapter 描述亦无反向边界。

## 决策

1. **候选模型加 `kind`**（`replace` / `append` / `replace_all`，缺省 `replace`）：replace=锚定替换（现状，original 非空）；append=追加章正文末尾；replace_all=替换整章正文（frontmatter 由壳保存时拼回 `frontmatterRaw + md` 保留）。旧库迁移：`PRAGMA table_info` 缺列则 ALTER ADD，旧行自动 'replace'。kind 创建后不可变。
2. **core 本地工具 `stage_chapter_proposal`**（AI SDK tool，非 MCP——26 个 MCP 工具契约不动，0011 纪律）：chat 正文产出一律经它以 pending 候选进暂存区，作者批量采纳才落盘。只在流式 chat 请求内可见（闭包会话 id 与挂载章 chapter），不暴露 /v1/tools；MCP 断连时本地工具仍可用。目标章两缺（参数与挂载章都没有）→ 返回引导文本不落库；mode=replace 缺 original → 返回报错文本不落库。
3. **铁律分工收口**：write_chapter 在 chat 通道降级为「作者明确指令直接落盘时才用」（审批门保留）；暂存提案工具不属危险工具、不弹审批卡（产出未落地，本就在人的裁决前）。
4. **设定路由（防 manuscript 污染）**：chat.md 工作流指引补路由——设定/伏笔/知情/道具托管/时间线 → `ledger_upsert`；书级元数据（声口/风格）→ `write_meta`；严禁把设定/账本/笔记写进 manuscript 章文件（含新建散章）。write_chapter / create_chapter 工具描述加同口径反向边界。
5. **壳采纳分派与呈现**：adopt() 按 kind 分派（append → 编辑器文档末尾追加；replace_all → setContent 整章替换；replace → 现状 applyEdit 锚定替换）；append/replace_all 无锚点不打内联删除线装饰（`anchoredIn` 过滤），暂存卡（抽屉与全览）卡头带 kind 徽标（替换/追加/整章）；chat 流式结束后若本轮调过 stage_chapter_proposal → 自动重拉暂存区。

## 工作流约束

- 本地工具只在流式 chat 内可见，不上 /v1/tools（工具集是 MCP 的）；chat.md 指引与工具描述随文件机制热重载（0008），domain 描述随下次发版生效。
- 新章草稿（kind=create，采纳时 create_chapter+写入）**缓做**，触发：真实写作提出需求。

## 落选 / 不做

- **执行前拦截式审批**（write_chapter 挂起、壳批准才执行）：需改 0007 流式协议（SSE 往返/挂起/超时/断连语义）、逐条打断而非批量采纳，工作量最大且不齐铁律语义。
- **仅提示词约束**：无机制兜底，靠模型自觉，铁律无防。
- 暂存提案工具的 kind 面继续扩展（如整本替换/跨章）——无真实需求不做。

## 验证（真实链路）

- 全量：`npm run check` 0 错（版本五处一致 v0.2.2）、`npm test` 全绿 581（core 147 / domain 235 / shell 199）、`cargo test` 绿、`e2e-workflow` 7/7（真实 LLM）。
- 实模型三探针（临时作品 .demo-work 副本，真 key）：
  1. 续写 → 工具序 `list_structure → read_chapter → stage_chapter_proposal`，候选 kind=append 131 字落暂存区，章文件字节数不变——正文进暂存区、未直写。
  2. 设定 → 工具序 `ledger_read → ledger_upsert`，无 create_chapter/write_chapter——设定进账本、不建散章。
  3. 候选 API kind=append + original='' → 200。
- 实机留意项（进亲测清单）：正文暂存提案与设定路由日常写作中是否持续生效。