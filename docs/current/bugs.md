# 活跃缺陷台账

只登记当前活跃缺陷（可定位、可修复、可核销）：条目带坐标与后果，修复批收口时核销删条，过程留 git。系统性弱点与需求仍归 `现状.md`「弱点与需求登记」节——那边管方向，这边管条目。

归档纪律（2026-08-23 立）：已发版批次的核销节随版移入 archive 批史件（命名 bugs-核销史-至v*.md，索引可索），本台账只保留未发版批次的核销与备查条目——current 件只回答「现在有什么没修」。

来源标注：[0822排查]=2026-08-22 四路全链路排查（core端点/壳调用层/MCP生命周期/skill体系，报告已归档可索）；[评审]=2026-08-22 两轮外部评审（工程质量+写作能力，任务单 `final-评审整改任务单.md` 与 `final-前端审查报告.md`）；[块4评审]=2026-09-05 块4新增代码大规模审查（六路深审+主代理亲证，报告 `docs/work/评审-块4新代码-2026-09-05.md`）。

## P1（4.2.1 修复批）

- [块4评审] 壳扫描链路 30s 死线+全链静默失败：`scanPromise` 未接长超时口径（缺省 30s，review 是 600s），服务端逐章串行 LLM 必超→整批提案丢弃；服务端 LLM 循环不随客户端断连中止（继续烧钱）；壳 scan/decide 无 catch，失败伪装成空箱/零反馈。→ 4.2.1 修复。
- [块4评审] protect 写闸对 remove 全维失明：`protectHit` 只查 op 内嵌 entry/item/name 字段，DELETE 提案的顶层 id 永不命中→受保护条目可经撤线提案删除，规范「拦档」语义失效（缓解：仍需作者点采纳+账本有快照）。→ 4.2.1 修复。

## P2（修复归属见条目）

- [块4评审] 回读验证非实体维失真：remove clock/doNotReexplain/tripwire/protect **成功反判 ❌**（else 分支查的三张表不含 clock 等）；clock/登记表 upsert **恒 ✅ 空转**未真回读（`domain/src/inbox.ts` verifyTargets）。现 scan 只产 promise 维故潜伏，扩维即引爆。→ 4.2.1 修复。
- [块4评审] 裁决状态机无终态守卫：discarded 可再 adopt（重新落账）、adopted 可再 discard（丢 verify）；verify ❌ 仍置 adopted 无重验出口（`domain/src/inbox.ts` inboxAdopt/inboxDiscard 只按 id findIndex）。→ 4.2.1 修复。
- [块4评审] 收件箱路径白名单可命中 `ledger.md`/`style.md` 且无快照无账本解析守卫——显式传 inboxPath 即可把收件箱全文重组写进账本文件（对照 write_meta 有 parseLedger 守卫+快照）；LLM 经 MCP 可达的事实源覆写路径（`domain/src/inbox.ts` INBOX_PATH_RE/saveInbox）。→ 4.2.1 修复。
- [块4评审] 收件箱写路径无 CAS（ledger 有 assertLedgerUnchanged 口径）+ 读错误（EACCES/EBUSY）泛化为空箱→后续写以近空内容覆盖原文件（`domain/src/inbox.ts`）。→ 4.2.1 修复。
- [块4评审] 误报驳回后重扫描原样重入：入箱幂等只对 pending 去重，误报裁决的候选每次扫描重进收件箱；reanchorVolume 全仓无消费代码——「重报锚=下次扫描」≠规范「重报锚=卷锚」，直接放大裁决负担出口数据（`domain/src/inbox.ts`）。→ 4.2.1 修复（误报永久抑制+id 稳定化；「到卷才重报」挂有卷映射后）。
- [块4评审] scan id 不稳定：new 类 id=章内序号基（LLM 输出漂移→重扫同章得不同 id→去重失效产重复提案）；章键=全路径数字拼接（卷号重号碰撞、无数字章共用 0000，现净本语料不触发）（`core/src/scan.ts`）。→ 4.2.1 修复（id 改名字散列基）。
- [块4评审] scan 单章失败炸整批（全批原子，已花费判定全弃）+600s 是整批总死线非每章+错误不归类透传 SDK 英文原文（`core/src/scan.ts`）。→ 4.2.1 修复。
- [块4评审] scan detail 回填错位：任一草稿被 skip 后 added[i] 相对 detail[i] 整体左移=张冠李戴；`skipped.includes(added[i] ?? '')` 恒假死代码（`core/src/scan.ts`）。→ 4.2.1 修复（append 返回按序 outcomes）。
- [块4评审] 壳批量裁决注释「单条失败不中断」与实现相反（无逐条 catch，首条 reject 即中断，勾选不清、列表不刷、零反馈）+错误反馈通道缺失（load 失败伪装成「收件箱为空」）（`shell/src/lib/inbox.svelte.ts`）。→ 4.2.1 修复。
- [块4评审] 第三 tab 破坏互斥不变量：Toolbar 暂存/ChatColumn staged-note/AI 改写内部三入口漏清 `inbox.tabOpen`→暂存高亮但左栏仍是收件箱、AI 实时流不可见（既有行为回归）。→ 4.2.1 修复。
- [块4评审] 壳收件箱状态残留：restart_core/换书不清 entries/selected/lastScan（跨作品残留）；徽章冷启动恒空、重开 tab 不刷新（对照暂存徽章 boot 即拉）；busy 期间勾选框不禁用（中途操作与批次脱节）。→ 4.2.1 修复。
- [块4评审] recall-recheck 判据「同章召回率」未实现：基线用 30 章全集合分母（189/576=32.8%）比分层选区内 10 章（55/197）；per-fact 判定未落盘不可事后重算。0905 实测复算（`.bench/probe-recheck-scope.mjs`）：受限口径基线 31.0%、差 −3.1pp，判据仍过——**0018 终裁幸存**。→ 4.2.1 修复（双口径并列+落盘 per-fact）。
- [块4评审] layered-pipeline l3 续跑契约破坏：已完成章 return false 与失败 return false 不可区分→已完成态（done=120/120）重跑必抛「连续 5 章失败」，报错误导删 progress 重烧配额（`scripts/bench/layered-pipeline.mjs`）。→ 4.2.1 修复。
- [块4评审] 冷读预算闸未接线：`ledgerSlice` budget 参数 core 侧零调用方——30k 闸+composition 注入构成在真实冷读路径不生效（规范 05「实测生存条件」半成品）（`core/src/review.ts` callLedgerSlice）。→ 挂 4.3 接线+实跑验证。
- [块4评审] UPDATE 语义=upsert 插入（targetKey 手误=造新条目）、ADD=覆盖已存（陈旧提案无提示覆盖作者手改；CAS 只防文件并发不防语义陈旧）（`domain/src/proposal.ts`+ledger upsert）。→ 挂 4.3+ 语义决策（adopt 前目标在位/键占用校验）。
- [块4评审] inbox_append 零形状校验：坏草稿入箱 pending，adopt 时裸 TypeError 永不可裁决；targetKey 缺失时幂等键变 `ADD:undefined` 吞后续同型草稿（`domain/src/server.ts` z.record 直透）。→ 挂 4.3（入口加最小形状校验）。
- [块4评审] append 去重整提案 skip：多 op 提案与在箱重叠 1 键→其余新候选静默丢（与预筛自立「不静默丢弃」规约相悖）（`domain/src/inbox.ts`）。→ 挂 4.3（op 级部分入箱或重叠明细）。

## P3（遗留备查）

- [块1遗留] `shell/src/lib/candidates.svelte.test.ts` 是 CRLF/LF 混合行尾文件（历史遗留；编辑时注意保持所在区域一致，git 的 LF→CRLF 提示是既有状态非新引入）。
- [块1遗留] 回收站里无时间戳的垃圾文件（非 delete_chapter/delete_volume 产物）list_trash 列得出但无 originalPath，一键找回不可用——restore_trash 对这类条目报「无法从文件名还原原路径，请手动处理」，壳侧前置提示手动处理；设计取舍，列此备查。
- [环境级 flake] domain 测试 Windows 全量并行下偶发 temp 目录 rename EPERM（summaries.test.ts / create-rename-move.test.ts 各撞过一次；未改基线上可复现，非 R1 引入；单独重跑该文件稳定通过）。留此备查，撞上单跑确认即可。
