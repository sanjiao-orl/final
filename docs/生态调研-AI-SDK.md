# 调研报告：AI SDK（v7）本体 + 社区生态能力汇总

- 日期：2026-08-09
- 范围：本项目已安装的 harness（`ai@7.0.58` + `@ai-sdk/openai-compatible` + `@ai-sdk/mcp` + `@modelcontextprotocol/sdk`）之外，官方一方包与社区生态里**可靠**（采用度/维护活跃度经 npm registry 实测核验）的能力
- 核验方法：`api.npmjs.org` 周下载量 + registry 最后修改日期（均为 2026-08-09 实测）；GitHub 星数仅作参考

## 0. 结论摘要

- 本体（已装的 `ai` 包）里**真正值钱且我们没用**的能力：结构化输出 `generateObject`、有状态 `agent`、工具审批闸门、`smoothStream`、内置 OpenTelemetry 遥测——全部零新增依赖，第 4 周理解层是自然切入点。
- 官方一方包生态极其活跃（provider/UI 全家桶，周下载百万级），但**与本项目架构相关的极少**：UI 集成包被"壳纯渲染 + core SSE"架构排除，provider 包被 `openai-compatible` 覆盖。
- 社区生态里**可靠且可落地**的只有两类：`promptfoo`（LLM 评测回归，62 万/w）与 `Mastra` 的模块（memory/rag，74~131 万/w）；观测类（Langfuse）单作者自用可缓；TanStack AI 太新不碰。
- **明确不碰**：`@ai-sdk/react/vue/svelte`、`@ai-sdk/vercel`、CopilotKit、embed/RAG（0006 已定后置）、`ollama-ai-provider`（已停更）。

## 1. 本体能力全景（ai@7.0.58，已安装，按使用状态分组）

### 1.1 已在用（core 四条路径）
| 能力 | 位置 |
| --- | --- |
| `createOpenAICompatible` + `languageModel()` 双档路由 | `core/src/config.ts:33-39` |
| `streamText`（聊天 + 改写两条 SSE 管道） | `core/src/chat.ts:91`、`core/src/rewrite.ts:47` |
| `messages` 回放 / `system` / `tools` / `abortSignal` / `stopWhen` | `core/src/chat.ts:83-91` |
| `stepCountIs(8)` 工具循环步数刹车 | `core/src/chat.ts:87` |
| `createMCPClient` → `listTools` → `toolsFromDefinitions`（MCP 工具注入） | `core/src/mcp.ts:28-31` |
| `ai/test` 的 `MockLanguageModelV3/V4` | `core/test/helpers.ts` |

### 1.2 未用但有明确价值（全部零新增依赖）
| 能力 | 说明 | 价值点 |
| --- | --- | --- |
| `generateObject` / `streamObject` + `zodSchema` | 按 schema 校验的结构化输出 | 第 4 周理解层"一致性审阅清单"最对口：审阅条目（类型/章节/原文引用/严重度）结构化为后续"清单驱动修改"打底 |
| `agent`（`ToolLoopAgent`） | 有状态多步自主循环 | 需要多子任务并行（如每卷独立审阅）时替代手写多个 streamText 循环 |
| `ToolApprovalRequest` | 工具调用人工确认闸门 | 安全阀精神的延伸：AI 主动写正文前挂确认 |
| `smoothStream` | 流式 token 平滑 | 与壳端 DeltaBatcher 作用重叠，优先级低 |
| 内置 OpenTelemetry 遥测通道 | `ai` 自带，无需额外包 | 接入 Langfuse/本地观测的钩子，单作者可缓 |
| `createGateway`（已随依赖装入） | 多 provider 单入口路由 | 当前单 provider 双模型够用 |

## 2. 官方一方包生态（未安装，全部活跃：最近发布 2026-08-07）

### 2.1 provider 族（周下载量，2026-08-09 实测）
| 包 | 版本 | 周下载 | 对本项目 |
| --- | --- | --- | --- |
| `@ai-sdk/openai` | 4.0.36 | 10,204,448 | 已被 openai-compatible 覆盖 |
| `@ai-sdk/anthropic` | 4.0.36 | 10,019,197 | 同上 |
| `@ai-sdk/google` | 4.0.39 | 6,711,750 | 同上 |
| `@ai-sdk/amazon-bedrock` | 5.0.50 | 2,863,343 | 云服务，不适用 |
| `@ai-sdk/azure` | 4.0.37 | 2,064,438 | 云服务，不适用 |
| `@ai-sdk/xai` | 4.0.33 | 2,172,640 | openai-compatible 覆盖 |
| `@ai-sdk/deepseek` | 3.0.26 | 1,797,268 | **备选**：官方 DeepSeek 适配（推理参数/缓存对齐），背景档换模型时可评估 |
| `@ai-sdk/groq` | 4.0.26 | 1,757,919 | openai-compatible 覆盖 |
| `@ai-sdk/mistral` | 4.0.27 | 1,688,732 | 同上 |
| `@ai-sdk/togetherai` | 3.0.28 | 832,249 | 同上 |
| `@ai-sdk/fireworks` | 3.0.29 | 385,400 | 同上 |

### 2.2 UI/部署族（与本项目架构冲突，均不采用）
| 包 | 周下载 | 不采用原因 |
| --- | --- | --- |
| `@ai-sdk/react` | 7,328,559 | 壳是"纯渲染零产品逻辑" + 数据管道在 core SSE，前端 hooks 与架构冲突 |
| `@ai-sdk/svelte` | 461,092 | 同上（壳虽用 Svelte，但聊天状态已自管） |
| `@ai-sdk/vue` | 1,068,333 | 同上 |
| `@ai-sdk/vercel` | 90,677 | 部署相关，本地应用不适用 |

### 2.3 不存在/停更（避免踩坑）
- `@ai-sdk/ollama`、`@ai-sdk/qwen`、`@ai-sdk/moonshot`、`@ai-sdk/zhipu`、`@ai-sdk/baidu` —— npm 上不存在，国产/本地模型一律走 openai-compatible（当前已是）。

## 3. 社区生态（npm 实测核验）

### 3.1 可靠且有落点
| 项目 | 包 | 版本/周下载/最后更新 | 能力 | 对本项目 |
| --- | --- | --- | --- | --- |
| **Mastra** | `@mastra/core` | 1.57.0 / 1,316,934 / 2026-08-09 | TS 智能体框架：agent / workflow / RAG / memory / evals，兼容 AI SDK provider 与 MCP | 不整体引入；其模块若后续需要可单取（见下） |
| Mastra memory | `@mastra/memory` | 1.26.0 / 747,469 / 2026-08-09 | 结构化记忆（语义/工作记忆） | 与现有"sqlite 会话 + 回放预算"重叠；若理解层要**跨会话事实记忆**再评估 |
| Mastra RAG | `@mastra/rag` | 2.4.2 / 100,624 / 2026-08-08 | 分块/嵌入/检索管线 | 0006 已定"索引库后置"，现阶段不碰 |
| **Promptfoo** | `promptfoo` | 0.122.0 / 622,959 / 2026-08-04 | LLM 评测/回归（prompt 防回归、模型对比），可测任意 openai-compatible 端点 | **推荐 dev 依赖**：改系统提示/换模型后跑回归，直接服务北极星"可以让读者挑错，但不能感到离谱" |
| **Langfuse** | `langfuse` | 3.38.20 / 1,915,123 / 2026-06-18 | LLM 可观测/评测，经 OpenTelemetry 接 AI SDK，可自托管 | 单作者自用可缓；若第 4 周理解层要排查"为什么审阅漏项"再上 |

### 3.2 观察/不适用
| 项目 | 状态 | 判断 |
| --- | --- | --- |
| TanStack AI | alpha（2025-10 创建，~2.6k stars） | 太新，不碰；与壳架构也冲突 |
| CopilotKit | 4.8.2 / 4,598 周下载 | React 绑定，壳无关，不适用 |
| `mcp-remote` | 0.1.38 / 512,017 / 2026-02 | 远程 MCP 服务器客户端（HTTP/SSE） | 目前 domain 是本地 stdio；若未来接在线工具（如公开 MCP 目录）可评估 |
| `@modelcontextprotocol/inspector` | 2.1.0 / 235,913 / 2026-08-05 | MCP 服务调试器 | **开发期工具**：调 domain 工具时可用，不进产物 |
| `ollama-ai-provider` | 1.2.0 / 150,505 / **2025-01-17 停更** | 本地 Ollama 模型接入 | 已停更，不采用；本地模型走 openai-compatible |
| `@langchain/ai`、`ai-utils` | — | 不存在/2022 死包 | 排除 |

## 4. 建议清单（按北极星与路线图排序）

1. **第 4 周理解层开工时，用 `generateObject` + `zodSchema` 出审阅清单**（本体，零依赖）——这是生态盘点里最确定的一步。
2. **引入 `promptfoo` 做 dev 依赖回归**：写 8~12 条"改写/审阅黄金用例"，改提示词或换模型必跑；本地端点即 `LLM_BASE_URL`。
3. 需要多子任务并行审阅（每卷/每主题一个 agent）时用本体 `agent`，不引框架。
4. `ToolApprovalRequest`、`@ai-sdk/deepseek`、Langfuse、Mastra memory：留作条件触发（见上表），现阶段不引入。
5. 明确不碰清单（见 §0），避免生态噪音进仓。

## 5. 信息来源

- npm registry / downloads API（本报告全部版本、下载量、日期均为 2026-08-09 实测）
- [Vercel AI SDK](https://github.com/vercel/ai)（Apache-2.0，23k+ stars）
- [Mastra](https://github.com/mastra-ai/mastra)、[Promptfoo](https://github.com/promptfoo/promptfoo)、[Langfuse](https://github.com/langfuse/langfuse)、[TanStack AI](https://github.com/TanStack/ai)、[CopilotKit](https://github.com/CopilotKit/CopilotKit) 官方仓库与 npm 页
