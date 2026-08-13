#!/usr/bin/env node
/**
 * collect.mjs —— 起点中文网移动端 SSR 采集脚本（扫榜 + 取章）
 *
 * 依据 WS-8《跑通记录-qidian-mcp.md》结论落地：m.qidian.com 走移动端 SSR，
 * 普通 HTTP 请求即可（无浏览器、无登录墙），页面内嵌
 * `<script id="vite-plugin-ssr_pageContext" type="application/json">` 的 JSON
 * 即包含榜单 / 书页首章 / 章节正文全部数据。
 *
 * 纪律（与 WS-8 一致）：
 * - 内置移动 UA；请求间隔默认 2.5–4.5s 随机（--delay 可调），单次少量请求；
 * - 只取免费公开章节（vipStatus=0）；遇到付费章节 / 反爬 / 登录墙立即停止并
 *   打印阻塞点，不反复重试；
 * - 语料仅本地自用测试（版权纪律见同目录 README.md）。
 *
 * 用法：
 *   node collect.mjs rank [--list newpRank] [--top 10] [--json out.json]
 *   node collect.mjs book <bid> [--chapters 3] [--out <dir>]
 *
 * 环境：Node.js >= 18（全局 fetch，零依赖）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const RANK_BASE = 'https://m.qidian.com/rank/';
const BOOK_BASE = 'https://m.qidian.com/book/';
const CHAPTER_BASE = 'https://m.qidian.com/chapter/';

/** 榜单 key → 中文名（2026-08 实测页面内 SSR JSON 暴露的榜单）。 */
const RANK_LABELS = {
  fyRank: '飞跃榜',
  hotRank: '热销榜',
  dsRank: '大神榜',
  newpRank: '新人签约新书榜',
  signRank: '签约榜',
  newFans: '新粉榜',
  readIndex: '阅读指数榜',
  recRank: '推荐榜',
  updRank: '更新榜',
  newbRank: '新书榜',
};

const DEFAULT_DELAY_MS = 2500; // 基础间隔
const JITTER_MS = 2000; // 随机抖动，最终 2500–4500ms
const MAX_RETRY = 1; // 网络失败最多重试 1 次，反爬/登录墙不重试
const TIMEOUT_MS = 30000;

/** 从 m.qidian.com 页面 HTML 提取 SSR JSON（vite-plugin-ssr 注入）。 */
function extractSsrJson(html) {
  const m = html.match(
    /<script id="vite-plugin-ssr_pageContext" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!m) throw new Error('页面中未找到 vite-plugin-ssr_pageContext JSON（页面结构可能已改版）');
  return JSON.parse(m[1]);
}

/** 带 UA、限速、单次重试的 GET。HTTP 非 200 视为阻塞点，不重试。 */
async function fetchText(url, opts = {}) {
  const { delayMs = DEFAULT_DELAY_MS, retries = MAX_RETRY, label = url } = opts;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      console.error(`[重试] ${label}（第 ${attempt} 次）`);
      await sleep(delayMs);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': MOBILE_UA,
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        },
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new BlockedError(`HTTP ${res.status}：${label}（视为阻塞点，不重试）`);
      }
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof BlockedError || err.name === 'AbortError') throw err;
      if (attempt < retries) continue;
      throw err;
    }
  }
}

/** 阻塞点（反爬 / 登录墙 / 页面结构变化）：记录即止，不重试。 */
class BlockedError extends Error {}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 章节正文 HTML（`<p>段` 无闭合标签，或书页首章为 `\n` 分隔纯文本）→ 纯文本段落数组。 */
function htmlToParagraphs(content) {
  if (!content) return [];
  // 先统一 <br> / 块级标签 / <p> 为换行，再按行切段（兼容 <p> 与 \n 两种形态）
  const normalized = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|h\d)>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n');
  const paras = normalized
    .split(/\n+/)
    .map((chunk) => unescapeHtml(chunk.replace(/<[^>]+>/g, '')))
    .map((s) => s.trim())
    .filter(Boolean);
  const NOISE = /(正在加载|加载下一章|点击下一页|继续阅读|本章完|请收藏|加入书签|请务必|防盗章节)/;
  return paras.filter((p) => !NOISE.test(p));
}

function unescapeHtml(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

/** CJK 字符计数（正文长度口径，含标点外的汉字）。 */
function countCjk(text) {
  const m = text.match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

/** Windows/文件系统安全的目录与文件名。 */
function sanitize(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '·')
    .replace(/\s+/g, ' ')
    .trim();
}

function frontmatter(book, chapter, cid, bid) {
  return [
    '---',
    `title: ${chapter.chapterName ?? ''}`,
    'status: 语料',
    `source: 起点中文网《${book.bookName}》${book.authorName ?? ''} · https://m.qidian.com/chapter/${bid}/${cid}/`,
    '---',
    '',
  ].join('\n');
}

/** ---- 子命令 1：扫榜 ---- */
async function cmdRank({ list = 'newpRank', top = 5, json }) {
  if (!RANK_LABELS[list]) {
    console.error(`未知榜单 key：${list}。可选：${Object.keys(RANK_LABELS).join(' / ')}`);
    process.exit(2);
  }
  console.error(`[请求] ${RANK_BASE}（${RANK_LABELS[list]}）…`);
  const html = await fetchText(RANK_BASE);
  const data = extractSsrJson(html);
  const items = data.pageContext?.pageProps?.pageData?.[list];
  if (!Array.isArray(items)) {
    throw new BlockedError(`榜单数据 ${list} 缺失（页面结构可能已改版）`);
  }
  const rows = items.slice(0, top).map((b, i) => ({
    排名: b.rankNum ?? i + 1,
    书名: b.bName,
    作者: b.bAuth,
    分类: b.subCat ?? b.cat,
    bid: b.bid,
    数据: b.cnt ?? b.rankCnt ?? '',
  }));
  const table = rows.map((r) => `${r.排名}\t${r.书名}\t${r.作者}\t${r.分类}\t${r.bid}\t${r.数据}`);
  console.log(`榜单：${RANK_LABELS[list]}（共 ${rows.length} 本，来源 ${RANK_BASE}）`);
  console.log('排名\t书名\t作者\t分类\tbid\t数据');
  console.log(table.join('\n'));
  if (json) {
    fs.writeFileSync(json, JSON.stringify({ list, label: RANK_LABELS[list], items: rows }, null, 2), 'utf8');
    console.error(`已保存：${json}`);
  }
}

/** ---- 子命令 2：取章 ---- */
async function cmdBook(bid, { chapters: wantCount = 3, out }) {
  const bookUrl = `${BOOK_BASE}${bid}/`;
  console.error(`[请求] ${bookUrl}…`);
  const html = await fetchText(bookUrl, { label: `书页 ${bid}` });
  const data = extractSsrJson(html);
  const pd = data.pageContext?.pageProps?.pageData;
  const book = pd?.bookInfo;
  const cc = pd?.chapterContentInfo;
  if (!book || !cc?.firstChapterId) {
    throw new BlockedError(`书页数据缺失（bid=${bid}），可能为付费/受限书或页面已改版`);
  }

  const volDir = path.resolve(out ?? path.join(__dirname, '../../.demo-work/manuscript'), sanitize(book.bookName));
  fs.mkdirSync(volDir, { recursive: true });

  // 第 1 章直接来自书页 SSR（含全文），后续章节沿 next 链逐章请求
  const want = Math.max(1, wantCount);
  const chapters = [];
  let cid = cc.firstChapterId;
  let guard = 0;
  while (chapters.length < want && cid && guard++ < 20) {
    let chapter, from;
    if (chapters.length === 0) {
      chapter = {
        chapterId: cc.firstChapterId,
        chapterName: cc.firstChapterT,
        content: cc.firstChapterC,
        vipStatus: 0,
        next: cc.nextChapterId,
        wordsCount: null,
      };
      from = bookUrl;
    } else {
      const u = `${CHAPTER_BASE}${bid}/${cid}/`;
      await sleep(DEFAULT_DELAY_MS + Math.floor(Math.random() * JITTER_MS));
      console.error(`[请求] ${u}…`);
      const chHtml = await fetchText(u, { delayMs: 0, label: `章节 ${cid}` });
      chapter = extractSsrJson(chHtml).pageContext?.pageProps?.pageData?.chapterInfo;
      from = u;
      if (!chapter?.content) {
        throw new BlockedError(`章节 ${cid} 正文缺失（登录墙或已改版）`);
      }
    }
    if (Number(chapter.vipStatus) !== 0) {
      console.error(`[阻塞点] ${book.bookName} 第 ${chapters.length + 1} 章（id=${cid}）为 VIP 章节，免费前 N 章已取完，停止。`);
      break;
    }
    const paras = htmlToParagraphs(chapter.content);
    const body = paras.join('\n\n') + '\n';
    const cjk = countCjk(paras.join(''));
    const fname = sanitize(chapter.chapterName || `第${chapters.length + 1}章`);
    const fpath = path.join(volDir, `${fname}.md`);
    fs.writeFileSync(fpath, frontmatter(book, chapter, cid, bid) + body, 'utf8');
    chapters.push({
      chapterId: cid,
      chapterName: chapter.chapterName ?? '',
      vipStatus: chapter.vipStatus,
      wordsCount: chapter.wordsCount ?? null,
      cjk,
      file: path.relative(process.cwd(), fpath),
      source: from,
    });
    console.log(`第 ${chapters.length} 章：${chapter.chapterName ?? ''}（CJK ${cjk} 字，vip=${chapter.vipStatus}）→ ${fpath}`);
    cid = chapter.next ?? null;
  }

  const total = chapters.reduce((s, c) => s + c.cjk, 0);
  const summary = {
    fetchedAt: new Date().toISOString(),
    book: { bid, bookName: book.bookName, authorName: book.authorName, wordsCnt: book.wordsCnt, showWordsCnt: book.showWordsCnt },
    chapterCount: chapters.length,
    totalCjk: total,
    chapters,
    note: '语料仅本地自用测试；付费/VIP 章节不入库。',
  };
  const jsonPath = path.join(volDir, '_fetch-summary.json');
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n抓取摘要：${book.bookName}（${book.authorName ?? ''}），${chapters.length} 章，正文 CJK 合计 ${total} 字`);
  console.log(`语料目录：${volDir}`);
  console.log(`摘要文件：${jsonPath}`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'rank') {
    await cmdRank({
      list: args.list ?? 'newpRank',
      top: args.top !== undefined ? Number(args.top) : 5,
      json: args.json,
    });
  } else if (cmd === 'book') {
    const bid = args._[1];
    if (!bid) {
      console.error('用法：node collect.mjs book <bid> [--chapters 3] [--out <dir>]');
      process.exit(2);
    }
    await cmdBook(bid, {
      chapters: args.chapters !== undefined ? Number(args.chapters) : 3,
      out: args.out,
    });
  } else {
    console.error(`用法：
  node collect.mjs rank [--list newpRank] [--top 5] [--json out.json]
  node collect.mjs book <bid> [--chapters 3] [--out <dir>]
榜单 key：${Object.keys(RANK_LABELS).join(' / ')}
限速：请求间隔默认 ${DEFAULT_DELAY_MS}–${DEFAULT_DELAY_MS + JITTER_MS}ms`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(`[失败] ${err.message}`);
  process.exit(1);
});
