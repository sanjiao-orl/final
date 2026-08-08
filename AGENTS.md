# AGENTS.md — final(小说写作工作台;AI 唯一入口;人维护,AI 禁止增删改)

## 硬事实
- 产品:网文连载单作者本地 AI 写作工作台(小说领域的 Cursor)。Windows 桌面、纯本地、无账号、BYOK 双模型。
- 架构:harness+壳。`core/`=Node sidecar 核心(AI SDK v7 + MCP client + node:sqlite 会话 + 127.0.0.1 HTTP/SSE);`domain/`=MCP 领域服务(structure/entities/stats,stdio);`shell/`=Tauri 2 + Svelte 5 + TipTap(纯渲染,零产品逻辑)。
- 数据模型:作品=文件夹,章=一个 .md+frontmatter,场=章内三级标题;结构树由标题派生可重建,真相永远在正文文件;.novel/ 内部目录(sessions.sqlite/history/trash/usage.jsonl/index-cache)。
- 设计原则:人的方向 AI 的笔(AI 产出全部先进暂存区);结构即智能;可配置默认否(偏好改 theme.ts 发版,不设设置面板)。
- 北极星:网文长期更新，可以让读者挑错，但不能感到离谱。

## 禁令
- 禁止把小说正文全量注入上下文:永远检索/分片。
- 禁止新增设置项/插件体系/治理文件;规范膨胀即事故。
- 测试调用api key 见C:\Users\25007\Desktop\文档\OpenCode key。
- 改完一轮任务必须验证(测试/构建/实跑);无法验证就明说,禁止只报"已完成"。
- 每周末亲写验收是刹车:出口未达成,下周只做出口相关。

## 工程入口
- 安装/检查/测试:`npm install` / `npm run check` / `npm test`(以 package.json 为准)。
- core 开发:`npm run dev:core`;domain 开发:`npm run dev:domain`。
