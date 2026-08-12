/**
 * scan-report.ts —— 逐章扫描报告生成器（LAY 指标）。
 * 用法: npm run scan -w domain -- <workDir> [outPath]
 *   workDir: 作品文件夹绝对路径（需含 manuscript/）
 *   outPath: 可选，Markdown 报告输出文件；缺省只打印到 stdout
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CJK_BASELINE,
  CJK_RED_LINE,
  CJK_TARGET,
  DASH_LIMIT,
  NOTSHI_BASELINE,
  NOTSHI_TARGET,
  PARA_FAIL,
  PARA_WARN,
  SCENE_POOL_MIN,
  type ChapterScan,
  type Metric,
  type WorkScanResult,
  scanWork,
} from '../src/qualityScan.js';

const SEV_LABEL: Record<string, string> = {
  pass: '通过',
  warn: '警告',
  fail: '超标',
  info: '信息',
};

function sevMark(sev: string): string {
  return `【${SEV_LABEL[sev] ?? sev}】`;
}

function metricLine(m: Metric): string {
  const hits = m.hits
    .map((h) => `  - 行 ${h.line}: ${h.text}${h.text.length >= 60 ? '…' : ''}`)
    .join('\n');
  const more = m.more && m.more > 0 ? `\n  - …其余 ${m.more} 处略` : '';
  return `### ${m.label} — ${m.count} 次 ${sevMark(m.severity)}\n标准：${m.standard}\n${hits}${more}`;
}

function chapterSection(ch: ChapterScan, index: number): string {
  const head = `## ${index}. ${ch.title}\n\n路径：\`${ch.relPath}\`\n`;
  return head + '\n' + ch.metrics.map(metricLine).join('\n\n') + '\n';
}

function summaryTable(result: WorkScanResult): string {
  const keys = ['cjk', 'dash', 'notShi', 'metaDiscourse', 'paragraphLength', 'aiFiller', 'highFreq', 'exclamation', 'profanity', 'scenes'];
  const labels: Record<string, string> = {
    cjk: 'CJK',
    dash: '——',
    notShi: '不是X是Y',
    metaDiscourse: '元话语',
    paragraphLength: '长段',
    aiFiller: '口水词',
    highFreq: '高频词',
    exclamation: '！',
    profanity: '粗口',
    scenes: '场景',
  };
  const lines = [
    `| 章节 | ${keys.map((k) => labels[k]).join(' | ')} |`,
    `| --- | ${keys.map(() => '---').join(' | ')} |`,
  ];
  result.chapters.forEach((ch, i) => {
    const cells = keys.map((k) => {
      const m = ch.metrics.find((x) => x.key === k)!;
      return `${m.count}${SEV_LABEL[m.severity] === '通过' ? '' : ` ${SEV_LABEL[m.severity]}`}`;
    });
    lines.push(`| ${i + 1}. ${ch.title} | ${cells.join(' | ')} |`);
  });
  return lines.join('\n');
}

function bookSection(result: WorkScanResult): string {
  const { book } = result;
  const out: string[] = ['## 书级指标（跨章）', ''];
  const poolOk = book.scenePool.length >= SCENE_POOL_MIN;
  out.push(
    `### 场景轮换池 — ${book.scenePool.length} 个 ${sevMark(poolOk ? 'pass' : 'warn')}`,
    `标准：≥${SCENE_POOL_MIN} 个可用场景（writing-novel 场景多样性）`,
    book.scenePool.length > 0 ? `场景：${book.scenePool.join('、')}` : '（无 ### 场标题）',
  );
  if (book.sceneContinuity.length === 0) {
    out.push('', '### 连续同场景 — 0 处违规 【通过】', `标准：同一场景连续 ≤3 章必须切换${result.chapters.length < 3 ? '（章数不足 3，自动 N/A）' : ''}`);
  } else {
    out.push('', '### 连续同场景 — 违规');
    for (const v of book.sceneContinuity) {
      out.push(`- 「${v.scene}」连续出现在：${v.chapters.join(' → ')}`);
    }
  }
  if (book.templateParagraphs.length === 0) {
    out.push('', '### 跨章模板段落候选 — 0 个 【通过】', `标准：同一段落开头出现在 ≥2 个不同章（novel-improver 模板段落 0/单元）${result.chapters.length < 2 ? '（仅 1 章，自动 N/A）' : ''}`);
  } else {
    out.push('', '### 跨章模板段落候选');
    for (const t of book.templateParagraphs) {
      out.push(`- 「${t.opening}…」：${t.chapters.join('、')}`);
    }
  }
  return out.join('\n');
}

function renderReport(result: WorkScanResult): string {
  const out: string[] = [
    '# LAY 量化去 AI 味扫描报告',
    '',
    `- 扫描对象：\`${result.workDir}\`（${result.chapters.length} 章）`,
    '- 工具：domain `scan_quality`（确定性规则扫描，零 LLM 成本；实现自研，阈值/口径来自 LAY novel-writing-framework MIT 规则文档）',
    '- 阈值出处：`skills/writing-novel.md`（阶段二/三）、`skills/novel-improver.md`（硬性指标表）、`skills/piqie-writing.md`（铁律）、`skills/qidian-writing.md`（AI 指纹扫描）',
    '',
    '## 汇总',
    '',
    summaryTable(result),
    '',
    '## 逐章明细',
    '',
  ];
  result.chapters.forEach((ch, i) => out.push(chapterSection(ch, i + 1)));
  out.push(bookSection(result));
  out.push(
    '',
    '## 阈值附录',
    '',
    `| 指标 | 阈值 | 出处 |`,
    `| --- | --- | --- |`,
    `| CJK 字数 | 目标 ≥${CJK_TARGET} / 底线 ${CJK_BASELINE} / 红线 ${CJK_RED_LINE} | novel-improver 硬性指标 / writing-novel 阶段二 |`,
    `| 破折号 | ≤${DASH_LIMIT}/章 | novel-improver 硬性指标 |`,
    `| 不是X是Y | ≤${NOTSHI_TARGET}/章（底线 ${NOTSHI_BASELINE}） | writing-novel 阶段二 / zhi-dou 特征十一 |`,
    `| 正文元话语 | 0 | writing-novel 正文禁止元话语 |`,
    `| 段落长度 | ≤${PARA_WARN} 字（>${PARA_FAIL} 不友好） | novel-improver / writing-novel 阶段三 |`,
    `| AI 口水词 | 0 | novel-improver / piqie 铁律 7 |`,
    `| 高频词 | >5 次/章异常（≥4 候选） | writing-novel 阶段三 / novel-improver 重复形容词 ≤3 |`,
    `| 感叹号 | 战斗章 ≥2（信息项） | writing-novel 初稿到位原则 |`,
    `| 粗口 | 按角色语音卡（信息项） | writing-novel 角色语音卡 |`,
    `| 场景轮换池 | ≥${SCENE_POOL_MIN} 个（书级） | writing-novel 场景多样性 |`,
    `| 场景连续性 | 同一场景连续 ≤3 章（书级） | writing-novel / piqie 铁律 4 |`,
    `| 模板段落 | 跨章同开头段落 0（书级） | novel-improver 硬性指标 |`,
    '',
  );
  return out.join('\n') + '\n';
}

const workDirArg = process.argv[2];
if (!workDirArg) {
  console.error('用法: npm run scan -w domain -- <workDir> [outPath]（相对路径按仓库根解析）');
  process.exit(1);
}
// 相对路径一律按仓库根解析（npm run -w 会把 cwd 切到工作区目录，不能依赖 cwd）
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const resolveArg = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(repoRoot, p));
const result = scanWork(resolveArg(workDirArg));
// 报告里按调用方传入的路径原样展示（不写运行时机器绝对路径）
result.workDir = workDirArg;
const md = renderReport(result);
const outPath = process.argv[3];
if (outPath) {
  fs.writeFileSync(resolveArg(outPath), md, 'utf8');
  console.error(`报告已写入 ${resolveArg(outPath)}`);
}
process.stdout.write(md);
