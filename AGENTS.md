# AGENTS.md — final(小说写作工作台;AI 唯一入口;人维护,AI 不得擅自增删改,改动需作者指令)

## 项目
网文连载单作者本地 AI 写作工作台(小说领域的 Cursor):Windows 桌面、纯本地、无账号、BYOK 双模型。技术栈与包结构读目录和 package.json 自取,不在此复制。
不可推导的硬事实:
- 设计原则:人的方向 AI 的笔(AI 产出全部先进暂存区)/ 结构即智能 / 可配置默认否,可配置。
- 批次校验门:北极星双指标——成稿更快了吗 / 离谱更少了吗(决策 0011)。
- 数据模型已收口(0004 定稿 + 批三-2 账本四维深化),勿重开。

## 加载规则
- 日常任务:只读 `docs/current/现状.md`(当前事实/规范/待办的唯一基准,文末附决策速查)。
- 设计/判断类改动:先按序号查 `docs/decisions/`;新决策按序号定稿后再动工。
- 产品范围问题:读 `docs/reference/01-产品定义.md`(需求基线,设计不得与之冲突)。
- 禁止全量加载 `docs/archive/`;按需单点读(逐件索引见其 README),且一律不改写。
- 版本号/更新日期不手写,归 git;活跃文档只有 current/ 与 decisions/。

## 验证命令(收尾必跑,失败必修到通过;无法验证就明说,禁止只报"已完成")
- `npm run check` 0 错(含版本六处一致)
- `npm test` 全绿(core + domain + shell)
- 动 rust 时:`cargo test`(在 shell/src-tauri)
- key 在场才跑真实 LLM 闭环:`node core/scripts/e2e-workflow.mjs`(9 步);测试 key 见 `C:\Users\25007\Desktop\文档\OpenCode key`
- 改文档后:`npm run check:docs`

## 禁止
- 禁止把小说正文全量注入上下文:永远检索/分片。
- 禁止无作者明确指令执行 git 写操作(commit/push/release)。
- 禁止新建 README/CHANGELOG 等人用文档;不重写整篇文档,只同步更新对应条目。
- 规范文档膨胀需警醒,项目内容增量可接受。

## 协作协议
- 需求模糊或多条实现路径:列 2~3 个方案+推荐项问作者,不脑补架构决策。
- 每次变更端到端闭环,附可运行验证凭证;主 agent 审核不盲信回馈,必复核 diff/实跑。
- 最小 diff,拒绝无关重构;30 个 MCP 工具契约不动只做加法。
- 被作者纠正后:教训沉淀进 `docs/current/现状.md` 规范节;本文件改动需作者指令。
