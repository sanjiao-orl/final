# 活跃缺陷台账

只登记当前活跃缺陷（可定位、可修复、可核销）：条目带坐标与后果，修复批收口时核销删条，过程留 git。系统性弱点与需求仍归 `现状.md`「弱点与需求登记」节——那边管方向，这边管条目。

来源标注：[0822排查]=2026-08-22 四路全链路排查（core端点/壳调用层/MCP生命周期/skill体系，报告见 `docs/archive/`）。

## 块 0 核销（2026-08-22，0822排查 30 条全结）

**修复核销 26 条**：P0×10 全核（壳/core/MCP 超时取消族 + ledger append CAS）；P1——abortGenerate 接线、SelectionPopover 取消、mcp onerror 留痕重连、boot health 短超时、config 超时倒挂（确定性工具 45s 档）、静默漏章改 warn+skipped、domain prompts 热重载、裁决词表别名归一（放行→采纳/打回→驳回）、chat 数据层注入独立 15s 超时+归因分离；P2——审阅 Promise.all 逐项结算、SSE 断尾报错、mcp 退避刷屏+health 暴露 MCP 活性、rename_chapter 回滚、注入预算（2000 字符×3）、BOM 容错、多行 frontmatter、预置升级通道（shipped hash 清单）。

**核实核销 4 条**：责编 persona 与 review JSON 契约冲突——结构性成立，review.ts 注入点已加仲裁句（契约优先），效果待真实贵档审阅验证；chat.ts:163 误报——成立且根因相反（abort 本透传，缺独立注入超时），已修；domain 全量遍历阻塞——实测推翻：`scripts/perf-benchmark.mjs` 标称 100 章×3000 字 scan_quality 226ms / 300 章 636ms，「数十秒」承诺成立（附注：scan_quality 内存随章数超线性，300 章档净增 ~117MB，全稿驻留，量变大书再议）；壳吞错三处——声明确认取舍，非缺陷。

**转参考 2 条**：settings Tauri invoke 无超时（疑似低概率，未实证）；导出 vs 扫描容错哲学相反（扫描侧已改 warn+skipped，导出侧整体抛错属有意，口径是否统一留待真实误报驱动）。

## P2（遗留，块 0 新登记）

- [块0遗留] core `mcp.ts` abort 只在客户端侧拒绝该次请求：domain 子进程里已开始的全量扫描继续跑完，stdio 单通道被占住直到结束——彻底取消需 domain 侧支持请求 cancellation，属加法改造，暂未动。
- [块0遗留] 壳 `shell/src/lib/types.ts` ReviewFinding 镜像缺 domain 侧已有的 category/MINOR 字段——类型漂移债务，下次触及审阅链路时补齐。
