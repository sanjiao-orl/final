# AGENTS.md — final(小说写作工作台;AI 唯一入口;人维护,AI 禁止增删改)

## 硬事实
- 产品:网文连载单作者本地 AI 写作工作台(小说领域的 Cursor)。Windows 桌面、纯本地、无账号、BYOK 双模型。
- 架构:harness+壳。`core/`=Node sidecar 核心(AI SDK v7 + MCP client + node:sqlite 会话 + 127.0.0.1 HTTP/SSE);`domain/`=MCP 领域服务(structure/entities/stats,stdio);`shell/`=Tauri 2 + Svelte 5 + TipTap。
- 数据模型:尚在重建，需要查询当前事实。
- 设计原则:人的方向 AI 的笔(AI 产出全部先进暂存区);结构即智能;可配置默认否，可配置。
- 北极星:网文长期更新，可以让读者挑错，但不能感到离谱。

## 禁令
- 禁止把小说正文全量注入上下文:永远检索/分片。
- 规范膨胀需警醒。
- 测试调用api key 见C:\Users\25007\Desktop\文档\OpenCode key。
- 改完一轮任务必须验证(测试/构建/实跑);无法验证就明说,禁止只报"已完成"。
- 完成=工作agent自测通过+独立二审通过,缺一不算完成;二审由独立会话执行,不采信工作报告与文档声明,只信可执行证据(复跑测试/真实链路实测/独立核对数据)。
- 二审有权打回;打回项修复后必须复验,不接受"已修复"的声明。


## 工程入口
- 安装/检查/测试:`npm install` / `npm run check` / `npm test`(以 package.json 为准)。
- core 开发:`npm run dev:core`;domain 开发:`npm run dev:domain`。
