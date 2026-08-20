# AGENTS.md — final(小说写作工作台;AI 唯一入口;人维护,AI 禁止增删改)

## 硬事实
- 产品:网文连载单作者本地 AI 写作工作台(小说领域的 Cursor)。Windows 桌面、纯本地、无账号、BYOK 双模型。
- 架构:harness+壳。`core/`=Node sidecar 核心(AI SDK v7 + MCP client + node:sqlite 会话 + 127.0.0.1 HTTP/SSE);`domain/`=MCP 领域服务(structure/entities/stats,stdio);`shell/`=Tauri 2 + Svelte 5 + TipTap。
- 数据模型:已收口(0004 定稿 + 批三-2 账本四维深化);当前事实查 `docs/现状.md` 与 `docs/decisions/`。
- 设计原则:人的方向 AI 的笔(AI 产出全部先进暂存区);结构即智能;可配置默认否，可配置。
- 北极星:网文长期更新，可以让读者挑错，但不能感到离谱;批次校验门=成稿速度/离谱率双指标(决策 0011)。

## 禁令
- 禁止把小说正文全量注入上下文:永远检索/分片。
- 规范文档膨胀需警醒，项目内容增量可接受。
- 测试调用api key 见C:\Users\25007\Desktop\文档\OpenCode key。
- 改完一轮任务必须验证(测试/构建/实跑);无法验证就明说,禁止只报"已完成"。主agent负责审核时不能盲目采信回馈结论。



## 工程入口
- 安装/检查/测试:`npm install` / `npm run check` / `npm test`(以 package.json 为准)。
- core 开发:`npm run dev:core`;domain 开发:`npm run dev:domain`。
