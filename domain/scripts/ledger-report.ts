/**
 * ledger-report.ts —— 账本确定性诊断报告（BLOCKER 清零提示的 CLI 出口）。
 * 用法: npm run ledger -w domain -- <workDir> [ledgerPath] [issueLogPath]
 *   workDir: 作品文件夹路径（绝对或相对仓库根；需含 manuscript/）
 *   ledgerPath: 可选，账本文件相对 workDir 路径（默认 .novel/ledger.md）——注意相对 workDir，非仓库根
 *   issueLogPath: 可选，问题日志（issues.md，CR 格式）相对 workDir 路径——用于统计 BLOCKER 条数
 * 输出 findings（code/chapter/severity/category/message）+ hasBlockers + blockerCount；
 * BLOCKER 计数（确定性诊断 BLOCKER + 问题日志 `| BLOCKER |` 条数）已折叠进 hasBlockers，
 * 供壳端暂存区入口做「标红提示（不硬拦截）」的出口，未接壳时直接跑本 CLI。
 */
import path from 'node:path';
import { diagnosticsForWork } from '../src/ledger.js';

const workDirArg = process.argv[2];
if (!workDirArg) {
  console.error('用法: npm run ledger -w domain -- <workDir> [ledgerPath] [issueLogPath]');
  console.error('  workDir 相对路径按仓库根解析；ledgerPath/issueLogPath 相对 workDir（非仓库根）');
  process.exit(1);
}
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
// workDir：相对路径按仓库根解析（npm run -w 会切 cwd，不能依赖 cwd）；绝对路径原样
const resolveWorkDir = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(repoRoot, p));
// ledgerPath/issueLogPath：语义为「相对 workDir」，由 domain 工具内部 resolveInside(workDir, …) 解析，
// 此处原样透传（不按仓库根解析，避免语义错位）。
const ledgerPath = process.argv[3];
const issueLogPath = process.argv[4];

const result = diagnosticsForWork(resolveWorkDir(workDirArg), ledgerPath, issueLogPath);
// 报告里按调用方传入的路径原样展示（不写运行时机器绝对路径）
result.workDir = workDirArg;

const sevLabel: Record<string, string> = { BLOCKER: 'BLOCKER', MAJOR: 'MAJOR', MODERATE: 'MODERATE', MINOR: 'MINOR' };
const lines: string[] = [
  '# 账本确定性诊断报告',
  '',
  `- 作品：\`${result.workDir}\`（findings ${result.findings.length} 条）`,
  `- BLOCKER 状态：${result.hasBlockers ? `存在 BLOCKER（问题日志 ${result.blockerCount} 条 + 确定性诊断），暂存区入口应标红提示，不做硬拦截` : '无 BLOCKER'}`,
  '',
];
if (result.findings.length === 0) {
  lines.push('无确定性诊断发现。');
} else {
  lines.push('| 代码 | 章节 | 严重度 | 类别 | 说明 |', '| --- | --- | --- | --- | --- |');
  for (const f of result.findings) {
    const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${esc(f.code)} | ${esc(f.chapter ?? '账本')} | ${sevLabel[f.severity] ?? f.severity} | ${esc(f.category)} | ${esc(f.message)} |`);
  }
  lines.push('');
}
process.stdout.write(lines.join('\n') + '\n');
