# 0001 · Agent harness 选型：Vercel AI SDK v7

- 状态：已定稿（2026-08-08）
- 背景：novel-rl 手写约 1,325 行 LLM HTTP 基建，流式/多会话/持久化/多模型管理四缺口全缺（见 `docs/00-诊断-novel-rl.md` 2.3）。第三次出发不再手写 agent 内核，直接引入成熟 harness。

## 决定

agent 内核 = **Vercel AI SDK v7**（`ai` + `@ai-sdk/openai-compatible` + `@ai-sdk/mcp`）。

- 模型层：`streamText` / `generateText`，provider 走 OpenAI-compatible，双档模型（writing/background）由 `core/src/config.ts` 路由；
- 工具层：MCP client（`@ai-sdk/mcp`），领域能力全部以 MCP 工具暴露，见 0004；
- 会话持久化：自管，node:sqlite（AI SDK 只管消息格式 UIMessage，存储自己定）。

## 落选

| 候选 | 落选原因 |
| --- | --- |
| Pi（pi-ai / pi-agent-core） | agent 循环更成品，但其交互范式绑终端编码宿主，壳交互要自己另写；AI SDK 的消息/流式抽象与自定义 UI 壳更匹配 |
| 继续手写 | novel-rl 已实证：四缺口补课成本高于引入成熟库，且"防过度工程"话语掩护惯性自研是病灶之一 |
| LangChain/LlamaIndex 等编排框架 | 对单作者本地工具是杀鸡用牛刀，抽象层级错配 |

## 约束

- AI SDK 版本锁定见 `core/package.json`；升级前先在 `core/tests` 复跑全量再合入。
- 已知坑：AI SDK 的 mock provider（v3 内部测试模型）不响应 abort 信号，真实 provider 正常——测试断言勿依赖 mock 的 abort 行为。
