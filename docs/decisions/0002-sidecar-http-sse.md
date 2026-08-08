# 0002 · 接线方案：Node sidecar + HTTP/SSE，不过 Tauri IPC

- 状态：已定稿（2026-08-08）

## 决定

core 是一个独立 **Node sidecar 进程**，Tauri 壳通过本机 HTTP + SSE 与之通信；流式 token **不走 Tauri IPC**。

- 监听 `127.0.0.1`，随机端口；Bearer token 鉴权，token+port 写入 `core-runtime.local.json`（`.gitignore` 的 `*.local.json` 已覆盖），壳启动时读该文件接线；
- 对话流式走 SSE；token 以 30–50ms 批次进前端 store（壳的纪律：不逐 token setState）；
- Tauri 侧只负责：spawn sidecar、读 runtime 文件、渲染。spawn 用 `node` 直起（不经 npx 包装——Windows 下 npx 包装进程 SIGTERM 不传递，已实测登记）。

## 为什么不过 Tauri IPC

- IPC 逐 token 回调在超长流式（reasoning 最长实测 59.5s）下开销与丢帧不可控；SSE 是成熟通道，且 core 可脱离壳用浏览器裸联调（`/dev` 页面）——这是第 1 周的验收出口；
- sidecar 独立于壳存活/崩溃，会话持久化在 core 侧 node:sqlite，壳挂了重开不丢上下文。

## 落选

- **Tauri 命令/Rust 侧持有 LLM 逻辑**：Rust 重写 agent 层违背"不造轮子"，且 AI SDK 生态在 TS；
- **WebSocket**：SSE 单向流够用，少一层依赖。

## 端点（第 1 周实况）

- `GET /health`：存活+版本；
- `GET /dev`：裸联调页面（不读文档验收的机械出口之一）;
- `POST /chat`（SSE）：对话+工具调用流式；会话经 node:sqlite 重启可恢复。
