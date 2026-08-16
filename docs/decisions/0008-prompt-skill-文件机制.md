# 0008 · 提示词与 skill 统一文件机制

> 2026-08-16。起因:批一审计发现 core 三处 SYSTEM_PROMPT、domain 冷读契约、壳内指令模板全部硬编码——改一句提示词要发版;同时决定内置写作 skill。作者裁定:**内置指令/提示词与 skill 同一套文件机制管理**,不做硬编码内置,也不做管理 UI(文件系统即管理界面)。

## 决策

1. **单一事实源是 md 文件**,frontmatter:`name` / `kind: prompt|skill` / `applies_to`(prompt 用:chat|review|rewrite|cold_read)/ `description`(skill 用,注入清单)。正文即内容。
2. **目录解析顺序**:`NOVEL_PROMPT_DIR` 环境变量 > prod 已释放的 `<app_config_dir>/prompts/` > 开发态 `core/prompts/`(仓库内,随 git 管理)。首次运行由 core 把随包目录**释放**到 app 数据目录(缺文件才拷,永不覆盖用户改动)。
3. **prompt 类**:core/domain 启动时加载整文,替换原硬编码 const(chat、review、rewrite、冷读契约+slice 模板);文件缺失/损坏回退一行兜底提示,不崩。
4. **skill 类**:chat 系统提示只注入 name+description 清单;正文按需经 domain 工具 `skill_read(name)` 拉取(不给每轮 token 加固定税)。书级目录 `<workDir>/.novel/skills/` 同机制扫描,同名遮蔽 app 级。
5. **预置 skill 两个**:`去AI味润色`(原创改编——humanizer 系 MIT 理念中文化,不搬运 renwei-writing 文本,其 NOASSERTION 许可商用受限)+ `章节体检`(接线 scan_quality + ledger_diagnostics + 冷读,结构性检查不走 prompt 走确定性工具)。
6. **缓做**:管理 UI(skill 数量管不过来再评估);壳内指令模板(SelectionPopover/整改模板)搬家,UI 耦合,单独小批;热重载(现靠重启 core 生效)。

## 约束

- skill 是提示词内容,每个内置 skill 要挣回它吃的 token——宁缺毋滥,预置不超过 3 个。
- 机制服务于「改文件即生效」:任何 prompt/skill 迭代不再要求发版。
- 结构级检查(伏笔/时间线/口吻/知情权)永远是 domain 确定性工具的职责,不写成 skill。
