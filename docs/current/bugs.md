# 活跃缺陷台账

只登记当前活跃缺陷（可定位、可修复、可核销）：条目带坐标与后果，修复批收口时核销删条，过程留 git。系统性弱点与需求仍归 `现状.md`「弱点与需求登记」节——那边管方向，这边管条目。

归档纪律（2026-08-23 评审「流程安排」③立）：已发版批次的核心销节随版移入 `docs/archive/`（首件 `bugs-核销史-至v0.2.9.md`、第二件 `bugs-核销史-至v0.2.11.md`），本台账只保留未发版批次的核销与备查条目——current 件只回答「现在有什么没修」。

来源标注：[0822排查]=2026-08-22 四路全链路排查（core端点/壳调用层/MCP生命周期/skill体系，报告见 `docs/archive/`）；[评审]=2026-08-22 两轮外部评审（工程质量+写作能力，任务单 `final-评审整改任务单.md` 与 `final-前端审查报告.md`）。

## P3（遗留备查）

- [块1遗留] `shell/src/lib/candidates.svelte.test.ts` 是 CRLF/LF 混合行尾文件（历史遗留；编辑时注意保持所在区域一致，git 的 LF→CRLF 提示是既有状态非新引入）。
- [块1遗留] 回收站里无时间戳的垃圾文件（非 delete_chapter/delete_volume 产物）list_trash 列得出但无 originalPath，一键找回不可用——restore_trash 对这类条目报「无法从文件名还原原路径，请手动处理」，壳侧前置提示手动处理；设计取舍，列此备查。
- [环境级 flake] domain 测试 Windows 全量并行下偶发 temp 目录 rename EPERM（summaries.test.ts / create-rename-move.test.ts 各撞过一次；未改基线上可复现，非 R1 引入；单独重跑该文件稳定通过）。留此备查，撞上单跑确认即可。
