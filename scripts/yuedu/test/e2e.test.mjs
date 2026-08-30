// 端到端测试：本地模拟书站 + 手写 Legado 书源 → 全链路（search→info→toc多页→逐章翻页→净化→保真度→落盘）。
// 目的：在无外网依赖下锁死管线行为，同时充当「手写书源导入」的样例。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeCtx, searchBooks, fetchBook } from '../src/pipeline.mjs';

/** 手写书源（标准 Legado 3.0 格式，默认+##+nextTocUrl/nextContentUrl 形态）。 */
const SOURCE = {
  bookSourceName: '模拟书站',
  bookSourceGroup: 'e2e',
  bookSourceUrl: 'http://127.0.0.1', // 端口运行时替换
  searchUrl: '/search?q={{key}}&p={{page}}',
  ruleSearch: {
    bookList: 'class.result@tag.li',
    name: 'tag.h3.0@text',
    author: 'class.au.0@text##作者[:：]',
    bookUrl: 'tag.a.0@href',
  },
  ruleBookInfo: {
    name: 'id.title@text',
    author: 'id.author@text',
    intro: 'id.intro@text',
  },
  ruleToc: {
    chapterList: 'class.chlist@tag.li',
    chapterName: 'tag.a.0@text',
    chapterUrl: 'tag.a.0@href',
    nextTocUrl: 'id.next-toc@href',
  },
  ruleContent: {
    content: 'id.content@textNodes',
    nextContentUrl: 'id.next-page@href',
    replaceRegex: '[{"old":"本书由模拟站提供.*?阅读。","new":""}]',
  },
};

const BOOKS = {
  诡秘之主: { id: 'b1', author: '爱潜水的乌贼', chapters: ['第一章 小丑', '第二章 值夜者', '第三章 短章'] },
};

function chapterText(i, title) {
  const body = i === 3
    ? '（残章：仅剩试读）这不是一个完整的章节。'
    : Array.from({ length: 12 }, (_, k) => `　　第${k + 1}段：克莱恩走进雾气弥漫的贝克兰德，煤气灯在夜色中摇曳，占卜的线索藏在报纸的角落里。${k}`).join('\n');
  // 两层广告：书源 replaceRegex 负责「本书由模拟站提供…」，内置层负责「一秒记住…」
  return { title, body: `${body}\n一秒记住本站网址：mock.com` };
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const send = (s) => { res.end(s); };
      if (u.pathname === '/search') {
        const q = u.searchParams.get('q');
        send(`<html><body><ul class="result">
<li><h3><a href="/book/b1">${q}</a></h3><span class="au">作者：爱潜水的乌贼</span></li>
<li><h3><a href="/book/b9">无关书</a></h3><span class="au">作者：路人</span></li></ul></body></html>`);
        return;
      }
      if (u.pathname === '/book/b1') {
        send(`<html><body><h1 id="title">诡秘之主</h1><div id="author">爱潜水的乌贼</div>
<p id="intro">愚者的故事。</p>
<div class="chlist"><li>卷一</li>
<li><a href="/chapter/1">第一章 小丑</a></li><li><a href="/chapter/2">第二章 值夜者</a></li><li><a href="/chapter/3">第三章 短章</a></li></div>
<a id="next-toc" href="/toc2">下一页</a></body></html>`);
        return;
      }
      if (u.pathname === '/toc2') {
        send(`<html><body><div class="chlist">
<li><a href="/chapter/4">第四章 收网</a></li><li><a href="/chapter/5">第五章 风暴</a></li></div></body></html>`);
        return;
      }
      if (u.pathname.startsWith('/chapter/')) {
        const n = Number(u.pathname.split('/')[2]);
        const ch = chapterText(n, BOOKS.诡秘之主.chapters[n - 1] ?? `第${n}章`);
        const nextPage = n === 1 && !u.searchParams.has('p2')
          ? '<a id="next-page" href="/chapter/1?p2=1">下一页</a>'
          : '';
        send(`<html><body><div id="content">${ch.body}
本书由模拟站提供广告，请支持正版阅读。</div>${nextPage}</body></html>`);
        return;
      }
      res.statusCode = 404;
      send('nope');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('端到端：手写书源导入 → 全链路抓取（目录两页+正文翻页+三层净化+保真度+落盘）', async () => {
  const server = await startServer();
  const port = server.address().port;
  try {
    const source = structuredClone(SOURCE);
    source.bookSourceUrl = `http://127.0.0.1:${port}`;
    const outDir = mkdtempSync(path.join(tmpdir(), 'yuedu-e2e-'));
    const ctx = makeCtx(source, { delayMinMs: 0, delayMaxMs: 0, cookieFile: path.join(outDir, '.cookies.json') });

    // 搜索
    const hits = await searchBooks(ctx, '诡秘之主', { limit: 5 });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].name, '诡秘之主');
    assert.equal(hits[0].author, '爱潜水的乌贼'); // ## 作者[:：] 净化生效
    assert.ok(hits[0].bookUrl.endsWith('/book/b1'));

    // 抓取（无 max，全书 5 章）
    const { report, results } = await fetchBook(ctx, hits[0].bookUrl, {
      outDir,
      userRulesFile: null, // 不挂用户规则文件
      builtinClean: true,
      onProgress: () => {},
    });

    // 目录两页：5 章
    assert.equal(report.toc.realChapters, 5);
    assert.equal(report.toc.pages, 2);
    assert.equal(report.fetched, 5);

    // 正文翻页（第一章 p2）+ 三层净化：书源 replaceRegex 与 内置广告 各自命中每章
    assert.ok(report.cleanupLayers['书源'] >= 5, '每章书源层净化至少 1 次');
    assert.ok(report.cleanupLayers['内置'] >= 5, '每章内置层至少 1 次');

    // 保真度：第 3 章是残章 → suspect；其余正常
    const short = results.find((r) => r.title === '第三章 短章');
    assert.ok(short.suspect, '残章应标 suspect');
    assert.ok(report.suspects >= 1);
    assert.equal(results.filter((r) => r.error).length, 0);

    // 落盘：5 个 md + frontmatter 溯源
    const files = readdirSync(path.join(outDir, 'manuscript')).filter((f) => f.endsWith('.md'));
    assert.equal(files.length, 5);
    const first = readFileSync(path.join(outDir, 'manuscript', '0001-第一章_小丑.md'), 'utf8');
    assert.ok(first.includes('status: 语料'));
    assert.ok(first.includes(`source: 模拟书站`));
    assert.ok(first.includes('chapterUrl: http://127.0.0.1'));
    // 净化后正文不含广告，且两页正文都进来了（翻页拼接）
    assert.ok(!first.includes('本书由模拟站提供'));
    assert.ok(first.includes("第12段"));
    assert.ok(!first.includes("一秒记住"));
    assert.ok(existsSync(path.join(outDir, 'book.json')));
    assert.ok(existsSync(path.join(outDir, 'report.md')));

    // 断点续采：重跑全部命中缓存
    const ctx2 = makeCtx(source, { delayMinMs: 0, delayMaxMs: 0, cookieFile: path.join(outDir, '.cookies.json') });
    const { results: results2 } = await fetchBook(ctx2, hits[0].bookUrl, { outDir, resume: true, userRulesFile: null });
    assert.equal(results2.filter((r) => r.cached).length, 5);
  } finally {
    server.close();
  }
});
