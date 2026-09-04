# 活跃缺陷台账

只登记当前活跃缺陷（可定位、可修复、可核销）：条目带坐标与后果，修复批收口时核销删条，过程留 git。系统性弱点与需求仍归 `现状.md`「弱点与需求登记」节——那边管方向，这边管条目。

归档纪律（2026-08-23 立）：已发版批次的核销节随版移入 archive 批史件（命名 bugs-核销史-至v*.md，索引可索），本台账只保留未发版批次的核销与备查条目——current 件只回答「现在有什么没修」。

来源标注：[0822排查]=2026-08-22 四路全链路排查（core端点/壳调用层/MCP生命周期/skill体系，报告已归档可索）；[评审]=2026-08-22 两轮外部评审（工程质量+写作能力，任务单 `final-评审整改任务单.md` 与 `final-前端审查报告.md`）；[块4评审]=2026-09-05 块4新增代码大规模审查（六路深审+主代理亲证，报告 `docs/work/评审-块4新代码-2026-09-05.md`）。

## P2（活跃挂账）

- [4.3评审] review 冷读预算 30000 双事实源：core 硬编码（`core/src/review.ts` LEDGER_SLICE_BUDGET）vs domain DEFAULT_SLICE_BUDGET，MCP 边界无法 import 对齐，domain 调低缺省时 core 显式值胜出=冷读闸被静默放宽——挂 drift 检查账（domain 改缺省必须同步 core，或 4.5 前加一致性探测）。
- [4.3评审] 注入配额重分（character 0.15/promise 0.4→0.35）零行为级钉扎：混合大账本下角色卡被挤光无报警（现有用例断言预算级对配额不敏感）——随 4.4/4.5 真账本注入实测补钉。
- [4.3评审] samePersonVariants 全稿批量量级偏重（每 token×全词典编辑距离，亿级基本操作/300 章）+ 中文边界现状（全半角不折叠/繁简异形需显式登记，已有文档性测试钉住现状）——词典制落地时一并（候选：names 长度桶预筛+词典外提）。
- [4.3评审] 工具注册契约枚举测试仍缺（46 工具零「注册数=描述账」机器闸，registerTool 误删/改名全套件仍绿）——系统性弱点的本批实例，随 lint/format/CI 统一评估批一并（现状.md 弱点节已登记方向）。
- [审计] 裁决拒绝（写闸/证据闸/语义预检）的 denials 只回传调用方、不落条目留痕——批量裁决后无法追溯「哪些条目曾被拒过、拒因是什么」；随 4.4 预警面板处置反馈展示一并承接（展示层消费 denials，勿提前设计）。
- [审计] 「有意延后」卷锚（reanchorVolume）持久化但零消费：suppressedKeys 只收「误报」，延后键现状每次扫描原样重入——到卷抑制挂 4.4 预警雷达批卷映射落地一并接（4.2.1 提交记档在案，本条并档指 4.4）。

## 已核销（裁决回路加固，未随版；随版移 archive 批史件）

核销 commit：domain=e50913e；验证=check 0 错 + test 1119 绿（domain 446 / core 263 / shell 411，含回归钉 3 条）。

- [审计] ✅ NOOP 快车道免检+吞损坏块：全 NOOP 提案跳过全部闸直 adopted，且解析失败伪条目（ops 空）会被快车道无声采纳、✅ 覆盖「解析失败」留痕 → 全 NOOP 同过写闸（触碰即拦契约无豁免）+ 损坏块守卫（ops 空不可裁决抛「损坏」）；附带修复损坏块头部 id 归因（parseYaml 对裸 id 串返回字符串致 header?.id 恒空，损坏块一律 UNKNOWN 无法按 id 定位）（e50913e）。
- [审计] ✅ discard 丢 verify：回读❌后改判驳回时 entries 重建未携带既有 verify，「曾尝试落账失败」审计线索断裂 → discard 携带既有 verify 留痕（e50913e）。

## 已核销（4.3 角色卡批，未随版；随版移 archive 批史件）

核销 commit：domain=d735890、core=a7d67bc、shell=0a67126、promptfoo=1aec43a、评审修复=451716a；验证=check 0 错 + test 1117 绿（domain 443 / core 263 / shell 411，含三路子代理评审修复回归钉 12 条）。

- [块4评审] ✅ 冷读预算闸未接线 → review callLedgerSlice 传 budget=30000+注入构成随响应 ledgerSlice 回传（a7d67bc，测试钉 budget 入参与透传）。
- [块4评审] ✅ UPDATE/ADD 语义偏移 → adopt 前语义预检（UPDATE 目标在位/ADD 键空闲，character 维同检；不符转人工提案留 pending）（d735890+451716a）。
- [块4评审] ✅ inbox_append 零形状校验 → ops 最小 zod 形状（action/targetKey/op/rationale 必带，evidence 章必有），坏草稿入口拒收（d735890）。
- [块4评审] ✅ append 整提案 skip 静默丢 → op 级部分入箱+skippedKeys 重叠明细（d735890+451716a）。
- [块4评审] ✅ promptfoo 4.2 薄切片用例缺位 → 补账登记路由用例（1aec43a）；/v1/scan 链路断言归属修订=core 单测+真人小段承担（promptfoo 为 chat 侧口径）。

## 已核销（4.2.1 修复批，未随版；随版移 archive 批史件）

核销 commit：domain=f9929e7、core=11bdd73、shell=04e72b0、scripts=df8e87f；验证=check 0 错 + test 1078 绿（domain 413 / core 258 / shell 407，含新增回归钉）。

- [块4评审] ✅ 壳扫描链路 30s 死线+静默失败：scanPromise 接 opts 长超时（600s 对齐 review 口径）+服务端每章独立死线+AbortSignal.any 随断连中止+壳侧失败接 work.error 红条（11bdd73 / 04e72b0）。
- [块4评审] ✅ protect 写闸对 remove 全维失明：protectHit 补收顶层 id/character/name/fact 字段，写闸测试钉住（f9929e7）。
- [块4评审] ✅ 回读验证非实体维失真（删除成功反判❌/clock 恒✅空转）：逐维对账真实落点，失败路径测试钉住（f9929e7）。
- [块4评审] ✅ 裁决状态机无终态守卫：已裁决不可再裁决；回读❌保持 pending 可重试（upsert 幂等）或改判，❌ 持久化（f9929e7）。
- [块4评审] ✅ 收件箱白名单可命中 ledger/style 且无守卫：保留文件名拒收+账本解析拒写（口径同 write_meta）+resolveInsidePosix 符号链接落点校验（f9929e7）。
- [块4评审] ✅ 收件箱无 CAS+读错误泛化空箱：写前 CAS 复核+原子写，非 ENOENT 读错误如实抛出（f9929e7）。
- [块4评审] ✅ 误报驳回后重扫描原样重入：误报键永久抑制再入（有意延后仍重报，到卷抑制挂卷映射落地后启用）；配套 new 类 id 改名字散列基保跨扫稳定（f9929e7 / 11bdd73）。
- [块4评审] ✅ scan id 序号基漂移+章键全路径数字拼接碰撞：id=章键+名字散列（djb2）；章键取 relPath 末段数字补零（11bdd73）。
- [块4评审] ✅ scan 单章失败炸整批+600s 总死线+错误不归类：逐章隔离 errors 继续批+每章独立超时死线+稳定中文归类（11bdd73）。
- [块4评审] ✅ scan detail 回填错位+恒假死分支：inbox_append 加 outcomes 同序对齐（f9929e7 / 11bdd73）。
- [块4评审] ✅ 壳批量裁决「单条失败不中断」注释与实现相反+错误反馈缺失：逐条 try/catch 失败条保留勾选可重试，load/scan 失败接红条（04e72b0）。
- [块4评审] ✅ 第三 tab 破坏互斥不变量（三入口漏清 inbox.tabOpen）：openStaging/AI 改写内部单一出口关收件箱 tab（04e72b0）。
- [块4评审] ✅ 壳状态跨作品残留+徽章冷启动恒空+busy 勾选不冻结：openTab 每次刷新+boot 即拉+busy 冻结勾选（04e72b0）。
- [块4评审] ✅ recall-recheck 判据「同章」未实现+per-fact 未落盘：判据改同章受限口径、判定逐条落盘 jsonl、报告加 criterion/caveats 三限定记档（0905 实测复算 −3.1pp 判据仍过，v0.2.13 的 0018 终裁幸存且强化）（df8e87f）。
- [块4评审] ✅ layered-pipeline l3 续跑契约破坏：已完成章返 'done' 不计失败连击；实跑验证 done=120/120 重跑跳过 120 章零调用（df8e87f）。

## P3（遗留备查）

- [块1遗留] `shell/src/lib/candidates.svelte.test.ts` 是 CRLF/LF 混合行尾文件（历史遗留；编辑时注意保持所在区域一致，git 的 LF→CRLF 提示是既有状态非新引入）。
- [块1遗留] 回收站里无时间戳的垃圾文件（非 delete_chapter/delete_volume 产物）list_trash 列得出但无 originalPath，一键找回不可用——restore_trash 对这类条目报「无法从文件名还原原路径，请手动处理」，壳侧前置提示手动处理；设计取舍，列此备查。
- [环境级 flake] domain 测试 Windows 全量并行下偶发 temp 目录 rename EPERM（summaries.test.ts / create-rename-move.test.ts 各撞过一次；未改基线上可复现，非 R1 引入；单独重跑该文件稳定通过）。留此备查，撞上单跑确认即可。
