# Reader's Charter — The Cold Read

> 试跑记录:按 fiction-forge v2 冷读协议(MIT,`docs/cold-read.md`)对 `.demo-work` 第一卷第一章做一次读者式审阅。
> 目的:验证"检查携带跨章状态"能否抓到无状态 lint 漏掉的问题,与 WS-7 扫描器(LAY 量化指标)对同一章的发现并排对比。
> 协议出处:https://github.com/geobond13/fiction-forge (docs/cold-read.md + templates/,MIT)。

---

**Operation:** single-reader, cover-to-cover assessment of `.demo-work/manuscript/第一卷·风起/`(1 文件、1 章、正文约 1174 CJK 字)。
**Read every sitting:** this file + `reader_ledger.md` + last ~40 lines of `issues.md`。Then continue from the `NEXT:` marker in the ledger.
**Rule zero:** 不修改 `book/`(即 `.demo-work/manuscript/`)任何内容。全部产出进 `editorial_notes/cold_read_2026-08/`。

## Who I am while reading

我是一位刚花了钱买下这本《风起》的仙侠/江湖网文读者,带着编辑的耳朵。先体验、后诊断:每条问题都必须能说出它打断阅读的那个瞬间("我翻回去核对""我跳过了一段""我皱了皱眉")。读的过程中不查大纲(本书尚无)、不查修改历史、不查编辑笔记——地面事实只来自正文、frontmatter 结构数据与对原稿的定向检索。**对比侧的扫描器报告在账本定稿前不视为裁决依据**(试跑存在顺序偏差,见 batch_A 方法说明)。

## Batch plan

> 协议标准是每批 8–11 章;本次为 1 章试跑,单章成批,后续章节可继续沿用本账本。

| Batch | Files | Milestone | Status |
|---|---|---|---|
| A | 第一章·少年 | 试跑(开篇单章) | 完成 |

**Per batch:** (1) 按顺序通读全章;(2) 发现即追加进 `issues.md`;(3) 更新账本全部区块;(4) 写 `batches/batch_X.md`(what WORKS、逐章评分、批判语);(5) 设置 `NEXT:`。

## Severity taxonomy(按"把读者甩出多远"校准)

- **BLOCKER** — 破坏对文本的信任:与前文场景当场矛盾;时间线不可能;重复/粘贴的句子;角色使用其不具备的知识;物件/名字/既定事实出错。
- **MAJOR** — 硬绊脚,读者重读或略读:口吻出戏的对话;说明性倾倒;主题直说;无铺垫揭示;**已登记事实的重复解释(账本 §Do-not-re-explain)**;接缝处语气骤变;事后视角泄底。
- **MODERATE** — 注意到了,原谅一次,不会原谅三次:重复的场景形/意象(记次数);节奏塌陷;套路化开头;铺垫词簇。
- **MINOR** — 打磨:词癖、元数据错误。

Categories:`CONT` 连续性 · `CANON` 锁定决策/素材冲突 · `VOICE` 口吻 · `CRAFT`(show-then-tell 族) · `STRUCT` 结构 · `PACE` 节奏 · `REPEAT` 重复 · `META` 文件/标题/前注。
Issue 行格式(固定,后续工具与修复波依赖它):
`CR-### | ch:line | SEV | CAT | "quote" | why / reader-moment | fix direction | LINE/SCENE/STRUCT/META`

**本稿已知失败模式**(来自对比侧扫描器候选,验证而非假设):

- 高频词候选:林渡 ×7、铜钱 ×6、师父 ×5、作响 ×3、像是 ×3、六年 ×3(扫描器按 n-gram 计数,是否真为缺陷待判定);
- 长段 ×2(ch1:20 约 363 字、ch1:34 约 223 字,阈值 >200 警告/>300 不友好);
- CJK 1174 字,低于平台红线 1500。

_本稿的慢性倾向尚未定型(仅 1 章);若出现"解释自己"的倾向,修复方向优先减法。_

## Autonomy tiers

- **AUTO-FIX:** NONE(纯评估;rule zero,正文一字不动)。
- **PROPOSE**(由作者决定):整章删改/合并/重排;任何触及锁定设定、角色名册、道具结局的改动;arc 级改动。

## Seed ledger pointer

读者的起点状态(角色状态、未偿承诺、道具清单、do-not-re-explain 登记)见 `reader_ledger.md` 种子区块。**开读前已种下**,种子只来自 frontmatter 与类型惯例(不偷看正文)。

**⚠ SEED QUESTION #1(Batch A):** 铜钱"来历不明"(synopsis 断言)与正文"师父塞给他后立刻转身"之间,作者是否打算让"师父知道真相但不说"成为承诺?(正文判定:是——"像师父还没说完的半句话")

## Voice cards

- **叙述者:** 第三人称限知(林渡视角),感官密度高、比喻偏好重物材质(铅汁/铁);失败模式:同一意象两句内重复、一口气罗列感官清单、把氛围写满而推进变慢。
- **林渡:** 话少、内心独白安静、动作化("摸了摸怀里的铜钱");失败模式:把感受说出来而不是演出来(正文未犯);一旦他长篇自白或解释设定即破音。
- **师父:** 只出现两句,句式极短、谜语式("此去山下,凡事看清楚了再动手");失败模式:变话痨、变说明书。
- **行商/客栈邻房:** 只闻其声,压低嗓音;失败模式:两拨人听不出区别、修辞密度与叙述者同频。

Prose rubric:正文无元话语(无"本章/前文/后文"),标点规范(全角/半角混用是已知小瑕,不计入本文档的 prose 评审——归 META 观察)。

## Tripwires

- **铜钱 ≠ 茶钱/店钱:** 师父给的铜钱只有一枚(方孔红绳、沉一倍、来历不明),茶钱两枚、店钱二十文是普通钱——两账不可混淆,铜钱不得被当成普通钱花掉。
- **青崖山低语:** 茶棚行商 + 客栈邻房先后低声提及,若两拨人实为同一拨,须有伏笔标记;任何第三人公开谈论"青崖山的秘密"须先交代其知情来源。
- **十六年:** 林渡年龄锚点(道观十六年);后续不得出现其他岁数而不解释。
- **硬数字:** 两(走镖三十两)vs 文(店钱二十文);季节未锚定(清晨刺骨 vs 晌午日蒸,双温度信号并存——后续每章都要对照)。
- **师父临别两句:** "凡事看清楚了再动手""山下的事急不得——越是烫嘴的茶,越要等它凉一凉";第二句是"茶的比喻"还是"遇事箴言",后续不得改口。

## Pre-verified items to check in passing

- 无历史审阅记录(首次通读);对比侧扫描器的候选清单已列入"已知失败模式",读后逐条判定。

## Deliverables (after the final batch)

`batches/batch_A.md`(读者日志+评分+批判语)· `issues.md`(追加式问题日志)· `reader_ledger.md`(滚动账本)· `comparison.md`(扫描器 vs 冷读对比清单)· `conclusion.md`(第 4 周审阅清单形态结论)。
