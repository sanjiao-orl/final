# 活跃缺陷台账

只登记当前活跃缺陷（可定位、可修复、可核销）：条目带坐标与后果，修复批收口时核销删条，过程留 git。系统性弱点与需求仍归 `现状.md`「弱点与需求登记」节——那边管方向，这边管条目。

来源标注：[0822排查]=2026-08-22 四路全链路排查（core端点/壳调用层/MCP生命周期/skill体系，报告见 `docs/archive/`）；[评审]=2026-08-22 两轮外部评审（工程质量+写作能力，任务单 `final-评审整改任务单.md` 与 `final-前端审查报告.md`）。

## 块 0 核销（2026-08-22，0822排查 30 条全结）

**修复核销 26 条**：P0×10 全核（壳/core/MCP 超时取消族 + ledger append CAS）；P1——abortGenerate 接线、SelectionPopover 取消、mcp onerror 留痕重连、boot health 短超时、config 超时倒挂（确定性工具 45s 档）、静默漏章改 warn+skipped、domain prompts 热重载、裁决词表别名归一（放行→采纳/打回→驳回）、chat 数据层注入独立 15s 超时+归因分离；P2——审阅 Promise.all 逐项结算、SSE 断尾报错、mcp 退避刷屏+health 暴露 MCP 活性、rename_chapter 回滚、注入预算（2000 字符×3）、BOM 容错、多行 frontmatter、预置升级通道（shipped hash 清单）。

**核实核销 4 条**：责编 persona 与 review JSON 契约冲突——结构性成立，review.ts 注入点已加仲裁句（契约优先），效果待真实贵档审阅验证；chat.ts:163 误报——成立且根因相反（abort 本透传，缺独立注入超时），已修；domain 全量遍历阻塞——实测推翻：`scripts/perf-benchmark.mjs` 标称 100 章×3000 字 scan_quality 226ms / 300 章 636ms，「数十秒」承诺成立（附注：scan_quality 内存随章数超线性，300 章档净增 ~117MB，全稿驻留，量变大书再议）；壳吞错三处——声明确认取舍，非缺陷。

**转参考 2 条**：settings Tauri invoke 无超时（疑似低概率，未实证）；导出 vs 扫描容错哲学相反（扫描侧已改 warn+skipped，导出侧整体抛错属有意，口径是否统一留待真实误报驱动）。

## 待排批（2026-08-22 外部评审登记，未修）

### P1（[评审] R1 修复批：数据正确性与护栏，小 diff 高收益）

- [评审T1] domain `tools.ts:733`（createChapter）/`:590-598`（setFrontmatterTitle）/`:644-645`（chapterSetBlueprint）：title 含 `: `/`#`/引号等 YAML 特殊字符时直接字符串拼接，parseFrontmatter 静默容忍为 `{}`，标题/blueprint 状态静默丢失——写 fm 时对 title 安全序列化（JSON 双引号风格并转义 `"` 与 `\`）或前置断言拒绝报中文错，二选一勿混用（`assertUserTitle` :694-704 口径随之统一）。
- [评审T2] domain `ledger.ts:1917-1939` decisionAppend CAS 采样顺序倒置：先 readFileSync 取 existing、后采 `before = ledgerFileState(abs)`，窗口内外部更新被 stale 内容覆盖丢失——调换顺序与 issueAppend（:1774-1777）口径一致；补并发写竞态测试。
- [评审T3] domain `fsutil.ts:123`：symlink 章 `isSymbolicLink()` 直接 continue 不上报 onSkip——scan_quality/word_count/search_content/章序静默漏章；改走 onSkip 上报（参考 qualityScan.ts:631-635），各消费端计入 skipped。
- [评审T4] domain `qualityScan.ts:497-521/573-584/642-647`：scan_quality 内存随章数超线性（300 章净增 ~117MB，perf-benchmark 实测）——逐章即时抽取段落 opening（前 20 CJK）与场景标题后丢弃全文，openings 改按 opening 去重的紧凑结构；输出契约不变，目标 300 章档净增 ≤50MB。
- [评审T5] `.github/workflows/ci.yml` 补 `pull_request` 触发 + `timeout-minutes` + `concurrency` 取消组（同分支重复构建取消旧的）。
- [评审T6] `scripts/release.mjs:231-239` detectRepo 解析 git remote 失败时无警告回落硬编码 `'sanjiao-orl/final'`——回落打印醒目警告（含原因与目标仓）并支持 `--repo` 显式覆盖，或解析失败直接中止（择一）。

### P2

- [评审T7] `scripts/build-sidecar.mjs:608-609`（copyCorePrompts）/`:622-623`（node.exe 复制）先删后拷，中断损产物——改「先写临时目标→成功后 rename」原子替换（原现状.md 弱点节条目移交本台账）。
- [评审T8] `core/src/server.ts:144` 连接 token `!==` 全等比较——改 `crypto.timingSafeEqual`（两 Buffer 等长前处理，长度不等直接 false）。

### P3（[评审] 前端审查报告登记）

- [评审] `shell/src/lib/core.ts:532-543`：工具调用 Failed 终态仍轮询满 15s 才报错。
- [评审] `shell/src-tauri/src/lib.rs:632-635`：MCP_DOMAIN_CMD 引号拼接，路径含 `"` 会坏（安装目录可控，实际风险低）。
- [评审] 发布状态 pill 循环点击无确认，易误触。
- [评审T15] 文档收口：README.md:53 补 v0.2.6/v0.2.7 发布记录、:63 测试数口径（或改「以 CI 为准」）、工具数多处统一以实测为准；`docs/decisions/0007` protocol 值演进补标注（旧决策不改写只加标注）；多处「core 的 ledger.ts」坐标纠正为 `domain/src/ledger.ts`。

## 本轮核销（2026-08-22/23 修复批：台账 3 条 + 作者实测 1 条，全结）

- [作者实测 P1] 模型设置面板「实际没法用」：用途分配下拉只列 config.json 预设、环境变量预设选不到，保存校验拒绝其 id；兼容回退区四字段在预设生效时被忽略却可输入。修复（纯壳侧，core/Tauri 链路核实无需改）：下拉并入环境变量预设（`assignablePresets` 并集、归一化去重、env 项标注来源），保存校验放宽到 配置∪env 归一化 id（llmStatus 未加载时保持原口径），回退区在 presets 模式禁用输入框并明示被忽略。shell 测试 +4。
- [P2 块0遗留] domain 侧请求 cancellation：核实 core→domain `notifications/cancelled` SDK 链路本已通（@ai-sdk/mcp 透传 signal，MCP SDK abort 即发取消通知），缺 domain 响应——8 个全量读盘工具（scan_quality/word_count/ledger_diagnostics/ledger_reconcile/export_txt/search_content/list_structure/export_chapter_text）实现函数加可选 signal，逐章/逐文件循环 throwIfAborted，handler 传 extra.signal；取消抛 AbortError 提前退出，事件循环让位。`domain/tests/cancellation.test.ts` +11（spyOn readFileSync 确定性中段 abort，零时间断言）。
- [P2 块0遗留] ReviewFinding 类型漂移：壳 `core.ts`（台账坐标写的 types.ts 已漂移）镜像补 MINOR severity + 可选 category（对齐 domain FindingSeverity/FindingCategory）；core 侧核实 category 本就透传未动；审阅面板贵档发现加 category 小标。shell 测试 +1。
- [P3 块1遗留] 找回章闭环：domain 新增第 36 个工具 `restore_trash`（move-back 原子 rename，trash 副本不再存在；无时间戳/目标已存在/原路径非 manuscript/ 均拒绝；文件名解析与 list_trash 共用 parseTrashName 单一事实源）；壳找回（回收站面板 + AI 删章拒绝补偿）优先走新工具，旧版 core 404「工具不可用」兜底读回写（`isToolMissingError` 判定，503 重连不误兜底）。顺手修 `trashPathOf` 按 rejected 状态过滤永远扑空的潜在 bug（rejectApproval 先落定状态再找结果）。domain 测试 +6，shell 测试 +3。
- 验证：`npm run check` 0 错（check-versions 六处一致 v0.2.7）、`npm test` 全绿 916（core 234 / domain 336 / shell 346）、`cargo test` 17 绿；e2e-workflow 需真实 LLM key（provider 余额不足 401 照旧未跑，非代码回归）。

## P3（遗留备查）

- [块1遗留] `shell/src/lib/candidates.svelte.test.ts` 是 CRLF/LF 混合行尾文件（历史遗留；编辑时注意保持所在区域一致，git 的 LF→CRLF 提示是既有状态非新引入）。
- [块1遗留] 回收站里无时间戳的垃圾文件（非 delete_chapter/delete_volume 产物）list_trash 列得出但无 originalPath，一键找回不可用——restore_trash 对这类条目报「无法从文件名还原原路径，请手动处理」，壳侧前置提示手动处理；设计取舍，列此备查。
