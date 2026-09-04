# 缺陷台账核销史 · 至 v0.2.14（2026-09-05）

> 2026-09-05 随 v0.2.14 发版按「随版归档」纪律从 `docs/current/bugs.md` 移入，冻结不改写。本卷收 4.2.1 修复批、4.3 角色卡批、裁决回路加固批三节的核销明细（均已随 v0.2.14 发版）。

## 已核销（裁决回路加固批，随 v0.2.14）

核销 commit：domain=e50913e；验证=check 0 错 + test 1120 绿（domain 446 / core 263 / shell 411，含回归钉 3 条）。

- [审计] ✅ NOOP 快车道免检+吞损坏块：全 NOOP 提案跳过全部闸直 adopted，且解析失败伪条目（ops 空）会被快车道无声采纳、✅ 覆盖「解析失败」留痕 → 全 NOOP 同过写闸（触碰即拦契约无豁免）+ 损坏块守卫（ops 空不可裁决抛「损坏」）；附带修复损坏块头部 id 归因（parseYaml 对裸 id 串返回字符串致 header?.id 恒空，损坏块一律 UNKNOWN 无法按 id 定位）（e50913e）。
- [审计] ✅ discard 丢 verify：回读❌后改判驳回时 entries 重建未携带既有 verify，「曾尝试落账失败」审计线索断裂 → discard 携带既有 verify 留痕（e50913e）。

## 已核销（4.3 角色卡批，随 v0.2.14）

核销 commit：domain=d735890、core=a7d67bc、shell=0a67126、promptfoo=1aec43a、评审修复=451716a；验证=check 0 错 + test 1117 绿（domain 443 / core 263 / shell 411，含三路子代理评审修复回归钉 12 条）。

- [块4评审] ✅ 冷读预算闸未接线 → review callLedgerSlice 传 budget=30000+注入构成随响应 ledgerSlice 回传（a7d67bc，测试钉 budget 入参与透传）。
- [块4评审] ✅ UPDATE/ADD 语义偏移 → adopt 前语义预检（UPDATE 目标在位/ADD 键空闲，character 维同检；不符转人工提案留 pending）（d735890+451716a）。
- [块4评审] ✅ inbox_append 零形状校验 → ops 最小 zod 形状（action/targetKey/op/rationale 必带，evidence 章必有），坏草稿入口拒收（d735890）。
- [块4评审] ✅ append 整提案 skip 静默丢 → op 级部分入箱+skippedKeys 重叠明细（d735890+451716a）。
- [块4评审] ✅ promptfoo 4.2 薄切片用例缺位 → 补账登记路由用例（1aec43a）；/v1/scan 链路断言归属修订=core 单测+真人小段承担（promptfoo 为 chat 侧口径）。

## 已核销（4.2.1 修复批，随 v0.2.14）

核销 commit：domain=f9929e7、core=11bdd73、shell=04e72b0、scripts=df8e87f；验证=check 0 错 + test 1078 绿（domain 413 / core 258 / shell 407，含新增回归钉）。

- [块4评审] ✅ 壳扫描链路 30s 死线+静默失败：scanPromise 接 opts 长超时（600s 对齐 review 口径）+服务端每章独立死线+AbortSignal.any 随断连中止+壳侧失败接 work.error 红条（11bdd73 / 04e72b0）。
- [块4评审] ✅ protect 写闸对 remove 全维失明：protectHit 补收顶层 id/character/name/fact 字段，写闸测试钉住（f9929e7）。
- [块4评审] ✅ 回读验证非实体维失真（删除成功反判❌/clock 恒✅空转）：逐维对账真实落点，失败路径测试钉住（f9929e7）。
- [块4评审] ✅ 裁决状态机无终态守卫：已裁决不可再裁决；回读❌保持 pending 可重试（upsert 幂等）或改判，❌ 持久化（f9929e7）。
- [块4评审] ✅ 收件箱白名单可命中 ledger/style 且无守卫：保留文件拒收+账本解析拒写（口径同 write_meta）+resolveInsidePosix 符号链接落点校验（f9929e7）。
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
