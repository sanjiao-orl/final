# 活跃缺陷台账

只登记当前活跃缺陷（可定位、可修复、可核销）：条目带坐标与后果，修复批收口时核销删条，过程留 git。系统性弱点与需求仍归 `现状.md`「弱点与需求登记」节——那边管方向，这边管条目。

来源标注：[0822排查]=2026-08-22 四路全链路排查（core端点/壳调用层/MCP生命周期/skill体系，报告见 `docs/archive/`）；[评审]=2026-08-22 两轮外部评审（工程质量+写作能力，任务单 `final-评审整改任务单.md` 与 `final-前端审查报告.md`）。

## 块 0 核销（2026-08-22，0822排查 30 条全结）

**修复核销 26 条**：P0×10 全核（壳/core/MCP 超时取消族 + ledger append CAS）；P1——abortGenerate 接线、SelectionPopover 取消、mcp onerror 留痕重连、boot health 短超时、config 超时倒挂（确定性工具 45s 档）、静默漏章改 warn+skipped、domain prompts 热重载、裁决词表别名归一（放行→采纳/打回→驳回）、chat 数据层注入独立 15s 超时+归因分离；P2——审阅 Promise.all 逐项结算、SSE 断尾报错、mcp 退避刷屏+health 暴露 MCP 活性、rename_chapter 回滚、注入预算（2000 字符×3）、BOM 容错、多行 frontmatter、预置升级通道（shipped hash 清单）。

**核实核销 4 条**：责编 persona 与 review JSON 契约冲突——结构性成立，review.ts 注入点已加仲裁句（契约优先），效果待真实贵档审阅验证；chat.ts:163 误报——成立且根因相反（abort 本透传，缺独立注入超时），已修；domain 全量遍历阻塞——实测推翻：`scripts/perf-benchmark.mjs` 标称 100 章×3000 字 scan_quality 226ms / 300 章 636ms，「数十秒」承诺成立（附注：scan_quality 内存随章数超线性，300 章档净增 ~117MB，全稿驻留，量变大书再议）；壳吞错三处——声明确认取舍，非缺陷。

**转参考 2 条**：settings Tauri invoke 无超时（疑似低概率，未实证）；导出 vs 扫描容错哲学相反（扫描侧已改 warn+skipped，导出侧整体抛错属有意，口径是否统一留待真实误报驱动）。

## 待排批（2026-08-22 外部评审登记，未修）

### P3（[评审] 前端审查报告登记）

- [评审] `shell/src/lib/core.ts:532-543`：工具调用 Failed 终态仍轮询满 15s 才报错。
- [评审] `shell/src-tauri/src/lib.rs:632-635`：MCP_DOMAIN_CMD 引号拼接，路径含 `"` 会坏（安装目录可控，实际风险低）。
- [评审] 发布状态 pill 循环点击无确认，易误触。

## R1 核销（2026-08-23 评审修复批：T1-T8 全结，T15 随核销）

- [评审T1] frontmatter title 安全序列化：新增 `yamlSafeScalar`（含 YAML 特殊字符或首尾空白时走 JSON 双引号+转义，yaml 库读回 round-trip 不丢；plain 安全标题落盘字节不变），createChapter/setFrontmatterTitle/chapterSetBlueprint 三处写 fm 统一接入；assertUserTitle 口径本就一致零改动。domain 测试 +5。
- [评审T2] decisionAppend CAS 采样顺序对调（先 `ledgerFileState` 采样后 readFileSync，同 issueAppend 口径）；补 mock statSync 注入外部追加的竞态测试（反向验证旧顺序确实丢条目）。domain 测试 +1。
- [评审T3] collectMdFiles 符号链接改 warn+onSkip 上报（防链接逃逸口径不变），消费端 scan_quality/search_content/diagnostics 既有 onSkip 自动计入 skipped，消费端零改动；junction 测试验证（Windows 免管理员）。domain 测试 +1。
- [评审T4] scan_quality 内存超线性修复：段落即时抽取 ParaDigest 紧凑摘要（行号/cjk/前 60 字摘录/前 20 CJK opening）弃全文、opening 逐章折叠进书级 Map（章下标数组查尾去重）不驻留、metricHighFreq 字符串 Map 改模块级复用开放寻址散列表（Float64Array/Uint32Array 堆外存储；压位键 +HF_TAG3 标签区分二/三字键域 +键+1 避空槽哨兵——双边界为主 agent 复核时发现子代理原实现漏掉，已补）。输出契约逐字节不变（对 HEAD 旧实现合成书 JSON 比对一致）。300 章档净增 ~117MB→42.8MB（≤50 达标），100 章档 19.3MB，中位耗时 636ms→247ms 顺带提速。
- [评审T5] ci.yml +pull_request 触发、gate timeout-minutes: 30、顶层 concurrency（workflow+ref，cancel-in-progress）。
- [评审T6] release.mjs detectRepo 静默回落拆两条失败路径各自打醒目警告（git 失败带退出码+stderr / URL 解析不出带原始 url，均注明默认仓与 --repo 覆盖）；台账建议的 --repo 显式覆盖核实本已存在（显式时不经 detectRepo 天然不警告），故只做警告侧。
- [评审T7] build-sidecar.mjs copyCorePrompts/node.exe 复制改 copyViaTemp（pid 后缀临时目标→成功后 rename，失败清临时）原子替换；台账行号与实码不符（文件共 87 行），按实码位置修。
- [评审T8] server.ts Bearer 校验改 bearerTokenMatches（前缀比对 + 长度不等短路 false + timingSafeEqual）；补长度不等/等长相异/相等三态测试。core 测试 +1。
- [评审T15] 上轮已完成（README 发布记录补 v0.2.6/v0.2.7、验收口径改实测、0007 protocol 演进标注、工具数 36 统一；「core 的 ledger.ts」坐标核实活跃文档无此误，仅冻结归档件有不改），本条随之核销。
- 验证：`npm run check` 0 错（check-versions 六处一致 v0.2.7）、`npm test` 全绿 924（core 235 / domain 343 / shell 346，较 916 +8）、`node scripts/perf-benchmark.mjs` scan_quality 300 章档净增 42.8MB。8 项各自独立 commit，过程留 git。

## T9 核销（2026-08-23 正文跳转闭环，全结）

- [评审T9] 诊断/质检→正文跳转闭环：①壳层跳转协议落地——`shell/src/lib/jump-target.ts`（JumpTarget：quote 优先精确定位、line 兜底近似；行号统一「文件 1 起始含 frontmatter」口径，frontmatterLineCount 换算正文行，空白行向上贴靠、估算块位+文本校验纠偏）+ `work.jumpToChapter(relPath, target)`（跨章先开章含脏保存门禁，派单 pendingJump 由 Editor 消费一次即清）+ Editor 侧 revealRange（滚动居中 + 选区 + 1.8s jump-flash 闪烁高亮，not-found 弹轻提示）。②四类结果面板逐个接入：质检（章头面板每条 finding「定位」，located=false 置灰）、审阅（章卡头/章内诊断/贵档 quote/扫描命中行 L{n} 整行可点/书级连续同场景与模板段落章名芯片钮；书级无锚条目按公约置灰带说明）、对账（ledger_reconcile 并入审阅 standard/deep 档并行跑，findings 与诊断同流进章卡获得定位钮，anchors 计数进报告 reconcileAnchors，quick 档不跑——顺带补上「对账异常 · 审阅面板查看」的断链）、账本（ContextColumn 四维行尾「定位」：伏笔=末条 setup/payoff、道具=末条 custody、时钟=chapters[0]、知情=knows[0].since；snapshot LedgerView 镜像补 custody.line/quote、payoff.quote、knowledge.quote 四字段；无锚置灰）。审阅面板跳转前先收起覆盖层；账本栏不遮正文不收起。shell 测试 +21（jump-target 12 / review 对账并入 5 / jumpToChapter 4）。
- 验证：`npm run check` 0 错（check-versions 六处一致 v0.2.7）、`npm test` 全绿 945（core 235 / domain 343 / shell 367，较 924 +21）。

## R2 余量核销（2026-08-23：T13/T14/T12/T11/T10 全结；声口建档转正留块 2）

- [评审T13] 审阅面板术语中文化：ReviewPanel `SEV_LABEL` 改中文映射（BLOCKER→拦路/MAJOR→严重/MODERATE→中等/MINOR→轻微），新增 `CATEGORY_LABEL` 八类（CONT 连续/CANON 设定/VOICE 声口/CRAFT 笔法/STRUCT 结构/PACE 节奏/REPEAT 重复/META 元信息，未知值原样显示）；pill 一律显示中文、英文原值留 title（汇总行/章卡头/书级·章内·贵档 finding/类别 pill 逐一接入）；Toolbar 审阅入口 title 与徽标 title、面板档位说明内嵌文案同步中文化。ApprovalCard 挂起标签与 mini-mode 指示一并中文标签化（主 agent 审核顺手补齐，复用 APPROVAL_MODE_LABELS）。SCAN_SEV_LABEL 本就中文未动；review.svelte.ts 类型枚举是 domain 契约镜像不动。
- [评审T14] 审批模式 pill 就地三选：Toolbar pill 点击不再跳设置栏，改就地 overlay+menu 三选菜单（复刻方案下拉两件套）——逐项询问/同目标免问/全部放行各带一行说明、当前项 ✓；yolo 两段式确认（确认态 danger 文案「确认开启全部放行？写/删/导出将不再询问」，再点生效，点其他项/关菜单即取消）。文案常量入 `settings.svelte.ts`（APPROVAL_MODES/APPROVAL_MODE_LABELS/APPROVAL_MODE_DESCS 单一事实源），SettingsColumn 审批卡同源派生（英文原值留 title），pill 显示「审批·逐项询问」式中文。shell 测试 +4。
- [评审T12] 采纳后账本同步引导可点击预填：notice 协议扩 `action: {label, prefillChat}`（showNotice 可选第二参向后兼容；带 action 消隐放宽 12s 留按钮决策时间，纯文本仍 6s——主 agent 审核增补）；SnapshotToast 组件层组合点击行为（chat.setDraft 预填 + ui.showCol('chat') + 关提示），绕开 candidates→chat 循环依赖。candidates adopt 把 affectedChapters 传入通知，预填消息含章节清单与三要点（先列清单给我确认/确认后才写账本/无变动回「无需同步」）；触发口径不变（有诊断/对账发现才弹），不自动发送、不自动改账本。shell 测试 +2（snapshot 含 12s/6s 双口径；candidates 计数子串断言保留、补 action 断言）。
- [评审T11] 前章摘要滚动多章：domain `readChapterSummaries` before 模式加 `limit`（1-10 整数，缺省 1=现行为，非法抛中文错；从前一章往章序首部滚动收集有摘要章、跳过无摘要章、按章序升序返回），server schema 加法不改契约（仍 36 工具）；core `PREV_SUMMARY_LIMIT=3`、整节预算 1500→4000（逐条配额 floor(4000/N) truncateInjection + 整节兜底截断），节头「## 前章摘要（最近 N 章）」逐条 `### relPath` 小标——relPath 含卷目录，跨卷窗口的「卷级」标注口径即此（若原意是整卷一段摘要的卷级导生物，需另立任务）；`chat.md` 工作流指引加「主动调 read_chapter_summaries（limit 最大 10）」一行。domain 测试 +4、core 测试 +3（既有注入用例在 summary.test.ts 已适配多记录形态）。
- [评审T10 今生部分]「章节起草」skill 转正（0009）：措辞先改齐 0012 铁律（起草→`stage_chapter_proposal` 进暂存区由作者采纳落盘、`write_chapter` 仅作者明确直写、账本同步改「采纳后待同步清单」口径、纪律改「暂存区采纳是铁律：被退回改后重新进暂存区」），移出 candidates/ 入 `core/prompts/` 根并登记 SKILL_FILENAMES（预置 skill 2→3），shipped-hashes 补新文件 hash（chat.md 新版 hash 同补，升级通道闭合）；domain 零改动（skill_read flat 扫同一 promptRoot 即命中，实测 listSkills 含「章节起草」）。声口建档留 candidates/ 归块 2 声口批。
- 验证：`npm run check` 0 错（check-versions 六处一致 v0.2.8）、`npm test` 全绿 958（core 238 / domain 347 / shell 373，较 945 +13）、`npm run check:docs` OK。

## 本轮核销（2026-08-22/23 修复批：台账 3 条 + 作者实测 1 条，全结）

- [作者实测 P1] 模型设置面板「实际没法用」：用途分配下拉只列 config.json 预设、环境变量预设选不到，保存校验拒绝其 id；兼容回退区四字段在预设生效时被忽略却可输入。修复（纯壳侧，core/Tauri 链路核实无需改）：下拉并入环境变量预设（`assignablePresets` 并集、归一化去重、env 项标注来源），保存校验放宽到 配置∪env 归一化 id（llmStatus 未加载时保持原口径），回退区在 presets 模式禁用输入框并明示被忽略。shell 测试 +4。
- [P2 块0遗留] domain 侧请求 cancellation：核实 core→domain `notifications/cancelled` SDK 链路本已通（@ai-sdk/mcp 透传 signal，MCP SDK abort 即发取消通知），缺 domain 响应——8 个全量读盘工具（scan_quality/word_count/ledger_diagnostics/ledger_reconcile/export_txt/search_content/list_structure/export_chapter_text）实现函数加可选 signal，逐章/逐文件循环 throwIfAborted，handler 传 extra.signal；取消抛 AbortError 提前退出，事件循环让位。`domain/tests/cancellation.test.ts` +11（spyOn readFileSync 确定性中段 abort，零时间断言）。
- [P2 块0遗留] ReviewFinding 类型漂移：壳 `core.ts`（台账坐标写的 types.ts 已漂移）镜像补 MINOR severity + 可选 category（对齐 domain FindingSeverity/FindingCategory）；core 侧核实 category 本就透传未动；审阅面板贵档发现加 category 小标。shell 测试 +1。
- [P3 块1遗留] 找回章闭环：domain 新增第 36 个工具 `restore_trash`（move-back 原子 rename，trash 副本不再存在；无时间戳/目标已存在/原路径非 manuscript/ 均拒绝；文件名解析与 list_trash 共用 parseTrashName 单一事实源）；壳找回（回收站面板 + AI 删章拒绝补偿）优先走新工具，旧版 core 404「工具不可用」兜底读回写（`isToolMissingError` 判定，503 重连不误兜底）。顺手修 `trashPathOf` 按 rejected 状态过滤永远扑空的潜在 bug（rejectApproval 先落定状态再找结果）。domain 测试 +6，shell 测试 +3。
- 验证：`npm run check` 0 错（check-versions 六处一致 v0.2.7）、`npm test` 全绿 916（core 234 / domain 336 / shell 346）、`cargo test` 17 绿；e2e-workflow 需真实 LLM key（provider 余额不足 401 照旧未跑，非代码回归）。

## P3（遗留备查）

- [块1遗留] `shell/src/lib/candidates.svelte.test.ts` 是 CRLF/LF 混合行尾文件（历史遗留；编辑时注意保持所在区域一致，git 的 LF→CRLF 提示是既有状态非新引入）。
- [块1遗留] 回收站里无时间戳的垃圾文件（非 delete_chapter/delete_volume 产物）list_trash 列得出但无 originalPath，一键找回不可用——restore_trash 对这类条目报「无法从文件名还原原路径，请手动处理」，壳侧前置提示手动处理；设计取舍，列此备查。
- [环境级 flake] domain 测试 Windows 全量并行下偶发 temp 目录 rename EPERM（summaries.test.ts / create-rename-move.test.ts 各撞过一次；未改基线上可复现，非 R1 引入；单独重跑该文件稳定通过）。留此备查，撞上单跑确认即可。
