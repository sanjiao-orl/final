#!/usr/bin/env node
/**
 * cli.mjs —— yuedu-distill 命令行。
 *
 * 用法（在 C:\final 根目录）：
 *   node scripts/yuedu/cli.mjs sources list [关键词]
 *   node scripts/yuedu/cli.mjs sources validate [文件|all]
 *   node scripts/yuedu/cli.mjs search   <源> <关键词> [--limit 10]
 *   node scripts/yuedu/cli.mjs info     <源> <bookUrl>
 *   node scripts/yuedu/cli.mjs toc      <源> <bookUrl> [--limit 30]
 *   node scripts/yuedu/cli.mjs fetch    <源> <bookUrl> [--out .bench/yuedu/书名] [--max 3]
 *                                       [--resume] [--min-chars N] [--delay 2500,4500]
 *                                       [--cookie "k=v; k2=v2"] [--no-builtin-clean]
 *   node scripts/yuedu/cli.mjs clean    <文件.md|txt> [--out 文件] [--rules 用户规则.json]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { loadSourceFile, loadSourcesDir, pickSource, validateSource } from './src/source.mjs';
import { makeCtx, searchBooks, fetchBookInfo, fetchToc, fetchBook } from './src/pipeline.mjs';
import { cleanContent, toParagraphs } from './src/clean.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCES_DIR = path.join(ROOT, 'scripts', 'yuedu', 'sources');
const TOOL_DIR = path.join(ROOT, 'scripts', 'yuedu');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else args._.push(a);
  }
  return args;
}

function loadAllSources() {
  if (!existsSync(SOURCES_DIR)) return [];
  return loadSourcesDir(SOURCES_DIR);
}

function printTable(rows, cols) {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c[0]] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(cols.map((c) => c[0])));
  for (const r of rows) console.log(line(cols.map((c) => r[c[0]] ?? '')));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd) {
    console.log(readFileSync(path.join(TOOL_DIR, 'README.md'), 'utf8').split('\n').slice(0, 40).join('\n'));
    return;
  }

  if (cmd === 'sources') {
    const sub = args._[1] ?? 'list';
    const sources = loadAllSources();
    if (sub === 'list') {
      const kw = args._[2];
      const rows = sources
        .map((s, i) => ({ i, name: s.bookSourceName, group: s.bookSourceGroup ?? '', url: s.bookSourceUrl }))
        .filter((r) => !kw || String(r.name).includes(kw) || String(r.group).includes(kw) || String(r.url).includes(kw));
      printTable(rows, [['i', '#'], ['name', '名称'], ['group', '分组'], ['url', 'URL']]);
      console.log(`\n共 ${rows.length}/${sources.length} 个（导入目录: scripts/yuedu/sources/）`);
      return;
    }
    if (sub === 'validate') {
      const file = args._[2];
      const targets = file && file !== 'all' ? loadSourceFile(path.resolve(file)) : sources;
      const reports = targets.map(validateSource);
      const byVerdict = { full: [], partial: [], unusable: [] };
      for (const r of reports) (byVerdict[r.verdict] ?? []).push(r);
      console.log(`full=${byVerdict.full.length}  partial=${byVerdict.partial.length}  unusable=${byVerdict.unusable.length}\n`);
      const rows = reports.map((r) => ({
        verdict: r.verdict, name: r.name,
        engines: `d${r.engines.def}/c${r.engines.css}/j${r.engines.json}/r${r.engines.regexList}`,
        lack: r.unsupported.join(',') || r.missing.join(',') || '-',
      }));
      printTable(rows, [['verdict', '结论'], ['name', '名称'], ['engines', '引擎用量'], ['lack', '缺失/不支持']]);
      return;
    }
    throw new Error(`未知子命令: sources ${sub}`);
  }

  if (cmd === 'clean') {
    const file = path.resolve(args._[1]);
    const text = readFileSync(file, 'utf8');
    const rulesFile = args.rules ?? path.join(TOOL_DIR, 'clean-rules.user.json');
    let userRules = [];
    if (existsSync(rulesFile)) userRules = JSON.parse(readFileSync(rulesFile, 'utf8'));
    const cleaned = cleanContent(text, { userRules, builtin: args['no-builtin-clean'] !== true });
    const out = args.out ? path.resolve(args.out) : file.replace(/(\.\w+)?$/, '.cleaned.txt');
    writeFileSync(out, toParagraphs(cleaned.text), 'utf8');
    console.log(`净化完成 → ${out}`);
    for (const s of cleaned.stats) console.log(`  [${s.layer}] ${s.name} ×${s.count}${s.flagged ? `（${s.flagged}）` : ''}`);
    return;
  }

  // 以下命令都需要书源
  const sourceKey = args._[1];
  const sources = loadAllSources();
  const source = pickSource(sources, sourceKey ?? '');
  const ctx = makeCtx(source, {
    cookie: args.cookie,
    delayMinMs: args.delay ? Number(String(args.delay).split(',')[0]) : undefined,
    delayMaxMs: args.delay ? Number(String(args.delay).split(',')[1]) : undefined,
    cookieFile: path.join(ROOT, '.bench', 'yuedu', '.cookies.json'),
  });

  if (cmd === 'search') {
    const keyword = args._[2];
    const results = await searchBooks(ctx, keyword, { limit: Number(args.limit ?? 10) });
    printTable(results.map((b) => ({ name: b.name, author: b.author, kind: b.kind, bookUrl: b.bookUrl })), [
      ['name', '书名'], ['author', '作者'], ['kind', '分类'], ['bookUrl', 'bookUrl'],
    ]);
    return;
  }

  if (cmd === 'info') {
    const info = await fetchBookInfo(ctx, args._[2]);
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  if (cmd === 'toc') {
    const info = await fetchBookInfo(ctx, args._[2]);
    const { chapters, tocPages } = await fetchToc(ctx, info.tocUrl);
    const limit = Number(args.limit ?? 30);
    console.log(`《${info.name}》${info.author ?? ''}  共 ${chapters.length} 行（目录页 ${tocPages}）\n`);
    for (const c of chapters.slice(0, limit)) {
      console.log(`${c.isVolume ? '[卷] ' : '      '}${c.title}  ${c.url}`);
    }
    if (chapters.length > limit) console.log(`…（其余 ${chapters.length - limit} 行略）`);
    return;
  }

  if (cmd === 'fetch') {
    const bookUrl = args._[2];
    const outDir = args.out ?? path.join(ROOT, '.bench', 'yuedu', 'book');
    const { report } = await fetchBook(ctx, bookUrl, {
      outDir,
      max: args.max ? Number(args.max) : undefined,
      resume: !!args.resume,
      minChars: args['min-chars'] ? Number(args['min-chars']) : undefined,
      userRulesFile: path.join(TOOL_DIR, 'clean-rules.user.json'),
      builtinClean: args['no-builtin-clean'] !== true,
      onProgress: (done, total, title) => process.stdout.write(`\r[${done}/${total}] ${title.slice(0, 24)}        `),
    });
    process.stdout.write('\n\n');
    console.log(readFileSync(path.join(outDir, 'report.md'), 'utf8'));
    return;
  }

  
  throw new Error(`未知命令: ${cmd}`);
}

main().catch((err) => {
  console.error(`[yuedu] ${err.message}`);
  // 不用 process.exit：Windows 上 undici 连接未排空时强退会触发 libuv 断言并污染退出码
  process.exitCode = 1;
});
