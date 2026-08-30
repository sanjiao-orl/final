#!/usr/bin/env node
/**
 * fetch.mjs —— 番茄小说网章节采集（试车台批语料落地，第一阶段：只抓原文，不解码）
 *
 * 结构（2026-08-28 实测）：
 * - 书页 https://fanqienovel.com/page/<bookId> 内嵌 __INITIAL_STATE__，page 节有书名/作者等元数据；
 * - 目录 API https://fanqienovel.com/api/reader/directory/detail?bookId=<bookId>
 *   返回 data.allItemIds（全章节 itemId 扁平数组）与 chapterListWithVolume（分卷章节元数据）；
 * - 正文页 https://fanqienovel.com/reader/<itemId> 内嵌 __INITIAL_STATE__.reader.chapterData
 *   （title/content/chapterWordNumber/nextItemId 等）。正文含字体混淆（PUA 码点），
 *   解码由 decode.py 第二阶段完成（字体静态，映射表见 font-map.json）。
 *
 * 纪律（与 qidian-ssr 一致）：
 * - 内置移动 UA；请求间隔默认 2.5–4.5s 随机，单次少量请求；
 * - 反爬/改版/结构缺失=阻塞点，记录即停，不反复重试；
 * - 断点续抓：已存在的 raw json 跳过；语料仅本地自用测试（版权纪律见 README.md）。
 *
 * 用法：
 *   node fetch.mjs <bookId> [--chapters 500] [--out <dir>]
 * 产物：<out>/raw/<bookName>/<itemId>.json + _directory.json + _book.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const DEFAULT_DELAY_MS = 2500;
const JITTER_MS = 2000;
const MAX_RETRY = 1;
const TIMEOUT_MS = 30000;

class BlockedError extends Error {}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
      if (!res.ok) throw new BlockedError(`HTTP ${res.status}：${label}（视为阻塞点，不重试）`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof BlockedError || err.name === 'AbortError') throw err;
      if (attempt < retries) continue;
      throw err;
    }
  }
}

/** 从页面 HTML 提取 __INITIAL_STATE__（平衡括号截取，尾部可能带别的 script 内容）。 */
function extractInitialState(html, label) {
  const m = html.match(/__INITIAL_STATE__=(\{)/);
  if (!m) throw new BlockedError(`页面中未找到 __INITIAL_STATE__：${label}（页面结构可能已改版）`);
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new BlockedError(`__INITIAL_STATE__ JSON 不完整：${label}`);
  try {
    return JSON.parse(html.slice(start, end));
  } catch {
    throw new BlockedError(`__INITIAL_STATE__ JSON 解析失败：${label}（页面结构可能已改版）`);
  }
}

/** Windows/文件系统安全的名称。 */
function sanitize(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '·')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const args = { _: [] };
  const argv = process.argv.slice(2);
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

  const bookId = args._[0];
  if (!bookId || !/^\d+$/.test(bookId)) {
    console.error('用法：node fetch.mjs <bookId> [--chapters 500] [--out <dir>]');
    process.exit(2);
  }
  const want = args.chapters !== undefined ? Number(args.chapters) : 500;
  const outRoot = path.resolve(args.out ?? path.join(__dirname, '../../.bench'));

  // ---- 书页元数据 ----
  const pageUrl = `https://fanqienovel.com/page/${bookId}`;
  console.error(`[请求] ${pageUrl}…`);
  const pageState = extractInitialState(await fetchText(pageUrl, { label: `书页 ${bookId}` }), `书页 ${bookId}`);
  const p = pageState.page ?? {};
  if (!p.bookId) throw new BlockedError(`书页数据为空（bookId=${bookId}），书目无效或已下架`);
  const book = {
    bookId,
    bookName: p.bookName,
    author: p.author,
    category: p.category,
    abstract: p.abstract,
    chapterTotal: p.chapterTotal,
    creationStatus: p.creationStatus,
    fetchedAt: new Date().toISOString(),
  };

  // ---- 目录 ----
  await sleep(DEFAULT_DELAY_MS + Math.floor(Math.random() * JITTER_MS));
  const dirUrl = `https://fanqienovel.com/api/reader/directory/detail?bookId=${bookId}`;
  console.error(`[请求] ${dirUrl}…`);
  const dirJson = JSON.parse(await fetchText(dirUrl, { delayMs: 0, label: `目录 ${bookId}` }));
  const dirData = dirJson?.data ?? {};
  const allItemIds = Array.isArray(dirData.allItemIds) ? dirData.allItemIds : [];
  const withVolume = Array.isArray(dirData.chapterListWithVolume) ? dirData.chapterListWithVolume : [];
  if (allItemIds.length === 0) throw new BlockedError(`目录为空（bookId=${bookId}），阻塞或改版`);
  // itemId → { title, volumeName, needPay }
  const meta = new Map();
  for (const vol of withVolume) {
    for (const ch of vol ?? []) {
      if (ch?.itemId) meta.set(String(ch.itemId), { title: ch.title ?? '', volumeName: ch.volumeName ?? '', needPay: !!ch.needPay });
    }
  }

  const bookDir = path.join(outRoot, 'raw', sanitize(book.bookName));
  fs.mkdirSync(bookDir, { recursive: true });
  fs.writeFileSync(path.join(bookDir, '_book.json'), JSON.stringify(book, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(bookDir, '_directory.json'),
    JSON.stringify({ allItemIds, chapterListWithVolume: withVolume }, null, 2),
    'utf8',
  );
  console.error(`书目：《${book.bookName}》${book.author ?? ''}，目录 ${allItemIds.length} 章，本次取前 ${Math.min(want, allItemIds.length)} 章 → ${bookDir}`);

  // ---- 逐章抓 raw ----
  const ids = allItemIds.slice(0, Math.max(1, want));
  let fetched = 0;
  let skipped = 0;
  const failures = []; // { itemId, order, reason }——单章失败记入并跳过，连续 5 章失败=结构性阻塞才停
  let consecutiveFailed = 0;
  for (let i = 0; i < ids.length; i++) {
    const itemId = String(ids[i]);
    const fpath = path.join(bookDir, `${itemId}.json`);
    if (fs.existsSync(fpath)) {
      skipped++;
      continue;
    }
    await sleep(DEFAULT_DELAY_MS + Math.floor(Math.random() * JITTER_MS));
    const url = `https://fanqienovel.com/reader/${itemId}`;
    console.error(`[请求] ${i + 1}/${ids.length} ${url}…`);
    let cd;
    try {
      const state = extractInitialState(await fetchText(url, { delayMs: 0, label: `章节 ${itemId}` }), `章节 ${itemId}`);
      cd = state.reader?.chapterData ?? {};
    } catch (err) {
      // 单章失败（404 锁章/缺 __INITIAL_STATE__/超时）记入清单继续；连续 5 章失败=结构性阻塞，停
      consecutiveFailed++;
      console.error(`[跳过] 章节 ${itemId} 失败（${err.message}），连续失败 ${consecutiveFailed}`);
      failures.push({ itemId, order: i + 1, reason: err.message });
      if (consecutiveFailed >= 5) throw new BlockedError(`连续 ${consecutiveFailed} 章失败，判定结构性阻塞，停止（已抓部分可续）`);
      continue;
    }
    consecutiveFailed = 0;
    if (!cd.content) {
      console.error(`[跳过] 章节 ${itemId} 无 content（锁章/付费），记入失败清单继续`);
      failures.push({ itemId, order: i + 1, reason: 'content 缺失' });
      continue;
    }
    const m = meta.get(itemId) ?? {};
    const record = {
      itemId,
      bookId,
      bookName: book.bookName,
      order: i + 1,
      title: cd.title ?? m.title ?? '',
      volumeName: m.volumeName ?? '',
      needPay: cd.needPay ?? m.needPay ?? false,
      chapterWordNumber: cd.chapterWordNumber ?? null,
      firstPassTime: cd.firstPassTime ?? null,
      sourceUrl: url,
      fetchedAt: new Date().toISOString(),
      content: cd.content,
    };
    fs.writeFileSync(fpath, JSON.stringify(record), 'utf8');
    fetched++;
    if (fetched % 20 === 0) console.error(`[进度] 已抓 ${fetched} 章（跳过已有 ${skipped}）`);
  }
  if (failures.length) {
    fs.writeFileSync(path.join(bookDir, '_failures.json'), JSON.stringify(failures, null, 2), 'utf8');
    console.error(`[注意] ${failures.length} 章跳过（见 _failures.json）`);
  }
  console.log(`抓取完成：《${book.bookName}》新抓 ${fetched} 章，跳过已有 ${skipped} 章，失败跳过 ${failures.length} 章，共 ${ids.length} 章目标`);
  console.log(`raw 目录：${bookDir}`);
}

main().catch((err) => {
  console.error(`[失败] ${err.message}`);
  process.exit(err instanceof BlockedError ? 3 : 1);
});
