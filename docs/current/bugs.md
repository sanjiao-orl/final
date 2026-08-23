# 活跃缺陷台账

只登记当前活跃缺陷（可定位、可修复、可核销）：条目带坐标与后果，修复批收口时核销删条，过程留 git。系统性弱点与需求仍归 `现状.md`「弱点与需求登记」节——那边管方向，这边管条目。

归档纪律（2026-08-23 评审「流程安排」③立）：已发版批次的核心销节随版移入 `docs/archive/`（首件 `bugs-核销史-至v0.2.9.md`），本台账只保留未发版批次的核销与备查条目——current 件只回答「现在有什么没修」。

来源标注：[0822排查]=2026-08-22 四路全链路排查（core端点/壳调用层/MCP生命周期/skill体系，报告见 `docs/archive/`）；[评审]=2026-08-22 两轮外部评审（工程质量+写作能力，任务单 `final-评审整改任务单.md` 与 `final-前端审查报告.md`）。

## 流程安排核销（2026-08-23：块 2 前置批 A 净化 + 批 B promptfoo 基建，全结；已随 v0.2.10 发布，下版随版归档）

- [评审-流程安排②] marked 输出净化提前（原 R3 缓做 D12，不等 D10-D12 安全整批）：shell 新增 `lib/sanitize.ts`（DOMPurify；白名单=html profile 覆盖 marked GFM 全部产物——表格/任务列表/删除线/代码块，显式 FORBID `style` 防 LLM 经 raw HTML 块注入全应用样式；裸 node 无 DOM 环境调用直接抛错、宁炸不放行）。三入口统一接线：chat 整泡 `renderAiHtml`、碰撞四节（ChatColumn 两处 marked.parse 并成同一条净化路径）、编辑器桥 `markdown.ts mdToHtml`（AI 采纳的 proposed 同为 LLM 输出，Editor innerHTML/insertContentAt 前过闸）。ChatColumn「本地单用户不引入 DOMPurify」旧注释口径废除。CSP 仍是兜底（script-src 'self' 拦内联脚本/外联图片），净化是第一道闸——markup/样式注入从此出不来。shell 测试 +8（sanitize 7：script/iframe/onerror/javascript:/style 剥除 + GFM 产物保留 + md→净化端到端；markdown 注入 1）；jsdom 仅测试 devDep。
- [评审-流程安排①] promptfoo 行为回归基建（从缓做提级块 2 前置）：`scripts/promptfoo/` 三件套——provider.mjs（promptfoo 0.122 类式自定义 provider：拉起真实 core+domain MCP、.demo-work 临时副本、POST /v1/chat 完整消费 SSE 聚合 `{text, toolCalls, truncated}`；整轮共用一个 core，进程退出自动清理）、promptfooconfig.yaml（首轮三用例：直接指令起草→`stage_chapter_proposal` 且 `write_chapter` 缺席；点名「章节起草」skill→先 `skill_read` 再提案、仍不直写；非正文诉求→零提案零直写）、README.md（运行口径）。root devDep promptfoo ^0.122 + `npm run promptfoo`。定位=本地手动回归（改 prompts 措辞/发版前跑，不进 CI，与 e2e 同口径）；shipped-hashes 只管分发一致，promptfoo 管语义不回归。
- 验证：`npm run check` 0 错、`npm test` 全绿 975（core 240 / domain 347 / shell 388，较 967 +8）、`cargo test` 17 绿、`npm run promptfoo` 真实 LLM 3/3 通过（5m04s；写作档 go/v1 预设余额不足，以 `LLM_ASSIGN_*` 覆盖到 OX_ALPHA_FREE 免费档跑通——行为断言考察措辞路由，与模型档位弱相关）。core/domain 零改动，e2e-workflow 未复跑（v0.2.9 已复跑成功且本批不触 core 链路；chat 行为面由 promptfoo 真跑覆盖）。

## P3（遗留备查）

- [块1遗留] `shell/src/lib/candidates.svelte.test.ts` 是 CRLF/LF 混合行尾文件（历史遗留；编辑时注意保持所在区域一致，git 的 LF→CRLF 提示是既有状态非新引入）。
- [块1遗留] 回收站里无时间戳的垃圾文件（非 delete_chapter/delete_volume 产物）list_trash 列得出但无 originalPath，一键找回不可用——restore_trash 对这类条目报「无法从文件名还原原路径，请手动处理」，壳侧前置提示手动处理；设计取舍，列此备查。
- [环境级 flake] domain 测试 Windows 全量并行下偶发 temp 目录 rename EPERM（summaries.test.ts / create-rename-move.test.ts 各撞过一次；未改基线上可复现，非 R1 引入；单独重跑该文件稳定通过）。留此备查，撞上单跑确认即可。
