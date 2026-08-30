// GUI 成功路径冒烟：本地 mock 书站 + 临时书源 → 走 GUI API 完成抓书/停止/净化
import http from 'node:http';
import { writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';

const API = 'http://127.0.0.1:8799';
const SRC_FILE = 'C:/final/scripts/yuedu/sources/_gui-test.json';
const OUT = 'C:/final/.bench/yuedu/gui-smoke';

// ---- mock 书站 ----
const chapters = Array.from({ length: 6 }, (_, i) => ({
  title: `第${i + 1}章 试炼${i + 1}`,
  path: `/c/${i + 1}`,
}));
const srv = http.createServer((req, res) => {
  const ok = (t) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(t); };
  if (req.url.startsWith('/search')) {
    ok(`<div class="bookbox"><h4><a href="/b/1">测试之书</a></h4><span class="author">测试作者</span></div>`);
  } else if (req.url.startsWith('/b/1')) {
    ok(`<h1>测试之书</h1><span class="author">测试作者</span><a class="toc" href="/toc/1">目录</a>`);
  } else if (req.url.startsWith('/toc/1')) {
    ok(chapters.map((c) => `<a class="ch" href="${c.path}">${c.title}</a>`).join(''));
  } else if (req.url.startsWith('/c/')) {
    const i = Number(req.url.slice(3));
    const ad = i === 2 ? '<div>一秒记住本站网址 biquge77.com</div>' : '';
    const filler = '这一段是足够长的正文内容用来通过保真度阈值检查，讲述主角在漫长试炼中一步步前行的心路历程与见闻，细节铺陈重复若干遍以保证字数超过两百以上。'.repeat(3);
    ok(`<div id="content">${ad}<p>　　第${i}章：${filler}</p><p>第二段：${filler}</p></div>`);
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

// ---- 临时书源（标准 Legado 形态） ----
const source = [{
  bookSourceName: 'GUI测试源', bookSourceGroup: '测试', bookSourceType: 0, bookSourceUrl: `${base}/`,
  enabled: true, enabledCookieJar: false,
  searchUrl: '/search?q={{key}}',
  ruleSearch: { bookList: '.bookbox', name: 'h4 a@text', author: '.author@text', bookUrl: 'h4 a@href' },
  ruleBookInfo: { name: 'h1@text', author: '.author@text', tocUrl: '.toc@href' },
  ruleToc: { chapterList: 'a.ch', chapterName: 'text', chapterUrl: 'href' },
  ruleContent: { content: '#content@html' },
}];
writeFileSync(SRC_FILE, JSON.stringify(source, null, 2), 'utf8');
rmSync(OUT, { recursive: true, force: true });
await new Promise((r) => setTimeout(r, 300)); // 等服务重扫? 源缓存——需要服务重启后首次调用
const post = (p, b) => fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (p) => fetch(API + p).then((r) => r.json());

let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => { if (cond) { pass++; console.log(' ✓', name); } else { fail++; console.log(' ✗', name, extra); } };

// 1. 源列表能看到临时源
let d = await get('/api/sources?kw=GUI%E6%B5%8B%E8%AF%95');
chk('书源列表含临时源', d.matched === 1 && d.list[0]?.verdict === 'full', JSON.stringify(d).slice(0, 120));

// 2. 搜索
d = await post('/api/search', { sourceKey: 'GUI测试源', keyword: '测试', limit: 5 });
chk('搜索命中', d.results?.[0]?.name === '测试之书' && d.results[0].bookUrl.endsWith('/b/1'), JSON.stringify(d).slice(0, 150));

// 3. 抓书（限 3 章）→ 完成 + 产物
d = await post('/api/fetch', { sourceKey: 'GUI测试源', bookUrl: '/b/1', outDir: OUT, max: 3, delayMin: 0, delayMax: 0 });
const job1 = d.jobId;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  d = await get(`/api/job/${job1}`);
  if (d.status !== 'running') break;
}
chk('任务完成', d.status === 'done', `status=${d.status} err=${d.error}`);
chk('报告：3 章成功 0 疑点', d.report?.fetched === 3 && d.report?.suspects === 0, JSON.stringify(d.report?.fidelity));
chk('净化命中内置广告', (d.report?.cleanupLayers?.['内置'] ?? 0) >= 1, JSON.stringify(d.report?.cleanupLayers));
chk('产物落盘', existsSync(OUT + '/manuscript') && existsSync(OUT + '/report.md'));
const mdFiles = existsSync(OUT + '/manuscript') ? readdirSync(OUT + '/manuscript').filter((f) => f.startsWith('0001-')) : [];
chk('第 1 章文件存在', mdFiles.length === 1, JSON.stringify(mdFiles));
const md = mdFiles[0] ? readFileSync(OUT + '/manuscript/' + mdFiles[0], 'utf8') : '';
chk('frontmatter 溯源', md.includes('source: GUI测试源') && md.includes('chapterUrl'));

// 4. 停止：不限章数启动，1 秒后停
d = await post('/api/fetch', { sourceKey: 'GUI测试源', bookUrl: '/b/1', outDir: OUT + '-stop', delayMin: 800, delayMax: 900 });
const job2 = d.jobId;
await new Promise((r) => setTimeout(r, 1000));
await post(`/api/job/${job2}/stop`, {});
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  d = await get(`/api/job/${job2}`);
  if (d.status !== 'running') break;
}
chk('停止生效（手动停止标记）', d.report?.stopped === true, `status=${d.status} stopped=${d.report?.stopped}`);

// 5. 单文件净化（路径取实际产物文件名，safeName 会把空格换成下划线）
d = await post('/api/clean', { file: OUT + '/manuscript/' + mdFiles[0], out: OUT + '/cleaned-out.txt' });
chk('净化端点写出产物', existsSync(OUT + '/cleaned-out.txt'), JSON.stringify(d).slice(0, 120));

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
srv.close();
rmSync(SRC_FILE);
process.exit(fail > 0 ? 1 : 0);
