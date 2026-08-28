---
title: prompt 与 skill 统一文件机制
last-verified: 2026-08-28
verified_commit: aeda20d
verify-with: core/src/prompts.ts、domain/src/prompts.ts、core/src/chat.ts 注入组装
---

# prompt 与 skill 统一文件机制

内置指令/提示词与 skill 同一套 md 文件机制管理，不做硬编码内置。**单一事实源是 md 文件，改文件即生效**（迭代不要求发版）。实现：`core/src/prompts.ts`（domain 侧冷读契约同构，`domain/src/prompts.ts` 同口径）。

## 文件格式

md + frontmatter：`name` / `kind: prompt|skill|persona|scheme` / `applies_to`（prompt 用：chat|review|rewrite|cold_read）/ `description`（skill 用，注入清单）。正文即内容。

## 目录解析与释放

- 解析序：`NOVEL_PROMPT_DIR` 环境变量 > prod 随包释放的 `<app_config_dir>/prompts/` > dev 仓库 `core/prompts/`（`prompts.ts` `resolvePromptRoot`）。
- 首启释放：core 把随包规范文件（含 personas/schemes 子目录）拷入 app 数据目录——**缺文件才拷，作者改过的永不覆盖**；升级通道靠 hash 清单（`core/src/shipped-hashes.json`）：目标文件内容 hash 在清单内 = 作者未改过 → 可安全覆盖为新版。
- 文件缺失/损坏回退一行兜底提示，不崩。

## 热重载

- prompt：mtime+size 双因子缓存，改文件即生效，不要求重启。
- skill / persona / scheme 清单：每次请求现扫，不缓存——文件增删即时生效。

## 书级遮蔽

书级目录 `<workDir>/.novel/` 下 `skills/`、`personas/`、`schemes/` 与 app 级同构扫描，**同名遮蔽**（遮蔽时清单只露书级）。激活方案指针 = `.novel/active-scheme` 单行文本，随书目录走。

## 注入方式与预算（chat 通道，`core/src/chat.ts`）

系统提示按三层组装，各层带字符预算闸，超限截断并加省略标注：

1. **契约层**：prompt md 整文 + workDir 行 + skill 清单（仅 name+description，≤2000）+ 碰撞协议（mode=collide 时，≤2000）。
2. **姿态层**：角色正文（请求带 persona 且按名能找到才注「## 当前角色」，≤2000；无指派 = 零注入）。core 只懂 persona 不懂方案；方案=「通道×角色」分配表（scheme frontmatter），由壳解析成 persona 名随请求带出，方案正文为人读备注**永不注入**。
3. **数据层**：声口摘要（有摘要才注）→ 本章账本切片（≤3000，章挂载会话才注）→ 滚动前章摘要（最近 3 章，总预算 4000）→ 讨论沉淀（仅碰撞模式，≤1500）。数据层注入挂独立超时（缺省 15s），缺/报错/超时 warn 降级，不阻断聊天。

skill 正文**不进系统提示**——按需经 domain 工具 `skill_read(name)` 拉取，不给每轮 token 加固定税。

## 写作铁律与路由（行为约束，执行面在 prompts 文件本体）

- chat 正文产出一律经 `stage_chapter_proposal` 进暂存区（候选 kind 三态见 `reference/03-协议契约.md`），作者采纳才落盘；`write_chapter` 仅作者明确指令直写时用（审批门保留）。
- 设定/伏笔/知情/道具/时间线 → `ledger_upsert`；书级元数据（声口/风格）→ `write_meta`；**严禁**把设定/账本/笔记写进 manuscript 章文件（含新建散章）。
- 上述措辞与工具描述的执行面在 `core/prompts/chat.md` 及 domain 工具描述，**改文件即生效**，本文件不复制全文（防双写漂移）。

## 约束

- 结构级检查（伏笔/时间线/口吻/知情权）永远是 domain 确定性工具的职责，不写成 skill。
- skill description 必须触发条件式（何时用 + 何时不用/反向边界）。
- 确定性检查不被方案配置、不被角色影响——方案只绑定 LLM 通道姿态。
- 领域工具集只加法不改约（38 个 MCP 工具契约稳定面）。
