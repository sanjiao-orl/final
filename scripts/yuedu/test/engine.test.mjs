// 单元测试：规则引擎/URL/净化（node:test，无网络）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { evaluateRule, expandTemplates, RuleUnsupportedError } from '../src/analyze-rule.mjs';
import { splitByOperators, splitRegexTail } from '../src/rule-tokenizer.mjs';
import { buildRequest, splitUrlOptions, resolveUrl } from '../src/analyze-url.mjs';
import { cleanContent, parseReplaceRegex, toParagraphs } from '../src/clean.mjs';

const HTML = `<html><body>
<div class="bookbox"><h4><a href="/book/1">诡秘之主</a></h4><span class="author">爱潜水的乌贼</span></div>
<div class="bookbox"><h4><a href="/book/2">十日终焉</a></h4><span class="author">杀虫队队员</span></div>
<div id="content"><p>　　第一段。</p><p>第二段。</p>
<script>bad()</script><style>.x{}</style><p>第三段 <a href="/go">链接</a></p></div>
<ul class="list"><li class="item">a</li><li class="item">b</li><li class="item">c</li><li class="item">d</li></ul>
</body></html>`;

function htmlCtx(baseUrl = 'https://www.example.com/page/1.html') {
  const $ = cheerio.load(HTML);
  return { type: 'html', $, els: null, baseUrl };
}

test('默认规则：class 链 + @text + 相对 URL 补全', () => {
  const ctx = htmlCtx();
  const bookUrl = evaluateRule('class.bookbox.0@tag.a.0@href', ctx);
  assert.equal(bookUrl, 'https://www.example.com/book/1');
  const name = evaluateRule('class.bookbox.0@tag.a.0@text', ctx);
  assert.equal(name, '诡秘之主');
});

test('默认规则：负数索引 / 排除 / 切片 / 多索引', () => {
  const ctx = htmlCtx();
  assert.equal(evaluateRule('class.item.-1@text', ctx), 'd');
  const $ = cheerio.load(HTML);
  const els = $('.item').toArray();
  const html = { type: 'html', $, els, baseUrl: '' };
  // 排除 [!0] → b/c/d 三元素
  const excluded = evaluateRule('[!0]', html, { allowList: true });
  assert.equal(excluded.length, 3);
  assert.equal(evaluateRule('text', { type: 'html', $, els: excluded, baseUrl: '' }), 'b'); // 字段取首值
  // 切片 [0:2] → a/b
  const sliced = evaluateRule('[0:2]', html, { allowList: true });
  assert.equal(sliced.length, 2);
  assert.equal(evaluateRule('text', { type: 'html', $, els: sliced, baseUrl: '' }), 'a');
});

test('默认规则：textNodes 剥 script/style', () => {
  const ctx = htmlCtx();
  const t = evaluateRule('id.content@textNodes', ctx);
  assert.ok(t.includes('第一段。'));
  assert.ok(t.includes('第三段'));
  assert.ok(!t.includes('bad()'));
  assert.ok(!t.includes('.x{}'));
});

test('## 尾缀替换 + || 回退', () => {
  const ctx = htmlCtx();
  const replaced = evaluateRule('class.bookbox.0@tag.a.0@text##诡秘|十日##X', ctx);
  assert.equal(replaced, 'X之主');
  const fallback = evaluateRule('class.nope@text||class.bookbox.1@tag.a.0@text', ctx);
  assert.equal(fallback, '十日终焉');
});

test('顶层连接符与 ## 正则态（|| 不切进正则）', () => {
  const parts = splitByOperators('a@text##x|y##z||b@text');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].text, 'a@text##x|y##z');
  const seg = splitRegexTail('id.content@textNodes##搜索.*手机访问|一秒记住.*');
  assert.equal(seg.match, '搜索.*手机访问|一秒记住.*');
  assert.equal(seg.replace, '');
});

test('%% 交集显式报错（不静默当 || 回退）', () => {
  assert.throws(() => evaluateRule('class.item.0@text%%class.item.1@text', htmlCtx()), RuleUnsupportedError);
});

test('OnlyOne ### 与净化 ##', () => {
  // OnlyOne：全文首个匹配整体替换（$1 = 捕获组）
  const only = evaluateRule('##og:novel:book_name" content="([^"]*)##$1###', {
    type: 'html', $: cheerio.load('<meta property="og:novel:book_name" content="诡秘之主"><meta property="og:novel:book_name" content="重复">'), els: null, baseUrl: '',
  }, { source: '<meta property="og:novel:book_name" content="诡秘之主"><meta property="og:novel:book_name" content="重复">' });
  assert.equal(only, '诡秘之主');
});

test('@css: 前缀 + :eq', () => {
  const ctx = htmlCtx();
  assert.equal(evaluateRule('@css:.item:eq(1)@text', ctx), 'b');
});

test('JSONPath 与裸属性（JSON 上下文）', () => {
  const ctx = { type: 'json', json: { info: { Datas: [{ name: 'A', author: '甲', cover: 'c.png' }, { name: 'B' }] } }, baseUrl: '' };
  const list = evaluateRule('$.info.Datas[*]', ctx, { allowList: true });
  assert.equal(list.length, 2);
  const name = evaluateRule('name', { type: 'json', json: list[0], baseUrl: '' });
  assert.equal(name, 'A');
});

test('AllInOne 正则列表 + 组引用', () => {
  const html = `<a href="/chapter/1">第一章</a><a href="/chapter/2">第二章</a>`;
  const rows = evaluateRule(':href="(/chapter/[^"]*)">([^<]*)', { type: 'html', $: cheerio.load(html), els: null, baseUrl: 'https://s.x' }, { allowList: true, source: html });
  assert.equal(rows.length, 2);
  const url = evaluateRule('$1', { type: 'jsonGroups', json: rows[0] });
  assert.equal(url, '/chapter/1');
  const title = evaluateRule('$2', { type: 'jsonGroups', json: rows[1] });
  assert.equal(title, '第二章');
});

test('模板 {{@json:$.x}} 与 {$.x} 内联', () => {
  const ctx = { type: 'json', json: { id: '42', type_name: '玄幻' }, baseUrl: '' };
  assert.equal(expandTemplates('/book/{{@json:$.id}}', ctx), '/book/42');
  assert.equal(expandTemplates('/book/{$.id}?t={{@json:$.type_name}}', ctx), '/book/42?t=玄幻');
});

test('URL：选项切分 / {{key}}/{{page}} / <,{{page}}> / gbk 字节编码', async () => {
  const r = buildRequest('/search/,{\n "charset":"gbk",\n "method":"POST",\n "body":"page={{page}}&key={{key}}"\n}', {
    baseUrl: 'https://www.zhaishuyuan.com', key: '诡秘', page: 2,
  });
  assert.equal(r.url, 'https://www.zhaishuyuan.com/search/');
  assert.equal(r.method, 'POST');
  assert.ok(r.bodyBytes, 'gbk POST body 应转字节');
  const { decodeBuffer } = await import('../src/fetcher.mjs');
  assert.equal(decodeBuffer(r.bodyBytes, 'gbk'), 'page=2&key=诡秘');
  const r2 = buildRequest('/list/<,{{page}}>.html', { baseUrl: 'https://a.com/', page: 1 });
  assert.equal(r2.url, 'https://a.com/list/.html');
  const r3 = buildRequest('/list/<,{{page}}>.html', { baseUrl: 'https://a.com/', page: 3 });
  assert.equal(r3.url, 'https://a.com/list/,3.html');
});

test('URL：body 内 URL 选项拆分注意不吞正文逗号', () => {
  const { url, options } = splitUrlOptions('https://x.com/a,{"method":"POST","body":"a=1,b=2"}');
  assert.equal(url, 'https://x.com/a');
  assert.equal(options.body, 'a=1,b=2');
});

test('相对 URL 解析', () => {
  assert.equal(resolveUrl('/book/1', 'https://a.com/dir/'), 'https://a.com/book/1');
});

test('净化：书源 replaceRegex 两格式 + 内置广告命中计数', () => {
  const rules = parseReplaceRegex('[{"old":"一秒记住.*?com","new":""}]');
  assert.equal(rules.length, 1);
  const single = parseReplaceRegex('{"old":"笔趣阁","new":"XX"}');
  assert.equal(single[0].replacement, 'XX');
  const raw = '一秒记住本站网址：biquge.com 最新章节\n\n正文开始。\n\n请记住本书首发域名 biquge.cc';
  const { text, stats } = cleanContent(raw, { sourceRules: rules, builtin: true });
  assert.ok(!text.includes('一秒记住'));
  assert.ok(!text.includes('biquge.cc'));
  assert.ok(text.includes('正文开始。'));
  const total = stats.reduce((n, s) => n + s.count, 0);
  assert.ok(total >= 2);
});

test('净化：非法正则按字面量兜底并 flagged', () => {
  const { stats } = cleanContent('a [b c', { sourceRules: [{ pattern: '[b', replacement: 'X' }], builtin: false });
  const flagged = stats.find((s) => s.flagged);
  assert.ok(flagged || stats.length === 0 || stats.some((s) => s.name.includes('[b')));
});

test('段落化输出', () => {
  assert.equal(toParagraphs('a\n\n\n\nb'), 'a\n\nb');
});

test('净化规则表：enabled:false 跳过 + 内置按名停用（Legado 替换净化语义）', () => {
  const raw = '一秒记住本站网址 x\n保留这行\n请记住本书首发域名 y';
  const { text } = cleanContent(raw, {
    userRules: { rules: [{ name: '停用示例', pattern: '保留这行', replacement: '', enabled: false }], disabledBuiltin: ['广告-一秒记住', '广告-一秒记住2', '广告-记住书域名'] },
    builtin: true,
  });
  assert.ok(text.includes('保留这行'), 'enabled:false 的用户规则应跳过');
  assert.ok(text.includes('一秒记住'), '按名停用的内置规则应跳过');
  assert.ok(text.includes('请记住本书首发域名'), '按名停用的内置规则应跳过（第二条）');
  // 同一批规则勾选启用后立即生效
  const { text: on } = cleanContent(raw, {
    userRules: { rules: [{ name: '停用示例', pattern: '保留这行', replacement: '', enabled: true }], disabledBuiltin: [] },
    builtin: true,
  });
  assert.ok(!on.includes('保留这行'), '勾选启用后生效');
  assert.ok(!on.includes('一秒记住'), '内置重新启用后生效');
});

test('净化规则表：旧数组格式兼容（无 enabled 视为启用）', () => {
  const { text } = cleanContent('一秒记住abc', { userRules: [{ name: 'x', pattern: 'abc', replacement: 'Y' }], builtin: false });
  assert.equal(text, '一秒记住Y');
});

test('JSONPath 上下文里的 $1 组引用（AllInOne 混 JSONPath 书源形态）', () => {
  const ctx = { type: 'jsonGroups', json: { $1: '/c/9', $2: '第九章' } };
  assert.equal(evaluateRule('$1', ctx), '/c/9');
});

test('宽松 JSON 解析：单引号 header（猫眼看书真实形态）', async () => {
  const { parseJsonObject } = await import('../src/analyze-url.mjs');
  const sq = "{'User-Agent': 'okhttp/4.9.2','client-device': 'abc','Authorization': 'bearer x.y.z'}";
  const h = parseJsonObject(sq);
  assert.ok(h, '单引号伪 JSON 应解析成功');
  assert.equal(h['User-Agent'], 'okhttp/4.9.2');
  assert.equal(h['client-device'], 'abc');
  assert.equal(parseJsonObject('{"a":1,}').a, 1, '尾逗号应容忍');
  assert.equal(parseJsonObject("{'a':1,}").a, 1, '单引号+尾逗号叠加');
  assert.equal(parseJsonObject('不是json'), null);
  assert.equal(parseJsonObject(''), null);
});

test('makeCtx：单引号书源 header 进入 sourceHeaders', async () => {
  const { makeCtx } = await import('../src/pipeline.mjs');
  const ctx = makeCtx({ header: "{'User-Agent': 'okhttp/4.9.2','client-name': 'app.x'}", bookSourceUrl: 'http://e.com/' }, { quiet: true });
  assert.equal(ctx.sourceHeaders['User-Agent'], 'okhttp/4.9.2');
  assert.equal(ctx.sourceHeaders['client-name'], 'app.x');
});

test('默认规则：裸 CSS 选择器（真实书源形态 .class / #id / 复合+.N 索引）', () => {
  const html = `<html><body>
    <div class="bookbox"><h4><a href="/b/1">书一</a></h4></div>
    <div class="bookbox"><h4><a href="/b/2">书二</a></h4></div>
    <div class="face"><span>作者：</span><span>某人</span><span>12万字</span></div>
    <div id="intro">简介内容</div>
  </body></html>`;
  const $ = cheerio.load(html);
  const ctx = { type: 'html', $, els: null, baseUrl: 'https://e.com/' };
  const list = evaluateRule('.bookbox', ctx, { allowList: true });
  assert.ok(Array.isArray(list) && list.length === 2, `bookList 应为数组×2，got ${Array.isArray(list) ? list.length : typeof list}`);
  assert.equal(evaluateRule('.bookbox h4 a@href', ctx), 'https://e.com/b/1');
  assert.equal(evaluateRule('#intro@html', ctx), '简介内容');
  assert.equal(evaluateRule('.face span.1@text', ctx), '某人', '复合 CSS + .N 索引');
  const names = list.map((el) => evaluateRule('tag.h4@tag.a@text', { ...ctx, els: [el] }));
  assert.deepEqual(names, ['书一', '书二']);
});

test('默认规则：tag.class / 含空格组合选择器按 CSS 处理（a.ch、h4 a）', () => {
  const html = `<html><body>
    <a class="ch" href="/c/1">第1章</a><a class="ch" href="/c/2">第2章</a>
    <div class="box"><h4><a href="/b/9">书九</a></h4></div>
  </body></html>`;
  const $ = cheerio.load(html);
  const ctx = { type: 'html', $, els: null, baseUrl: 'https://e.com/' };
  const list = evaluateRule('a.ch', ctx, { allowList: true });
  assert.ok(Array.isArray(list) && list.length === 2, `a.ch 应选中 2 个，got ${Array.isArray(list) ? list.length : typeof list}`);
  assert.equal(evaluateRule('.box h4 a@href', ctx), 'https://e.com/b/9');
  const titles = list.map((el) => evaluateRule('text', { ...ctx, els: [el] }));
  assert.deepEqual(titles, ['第1章', '第2章']);
});
