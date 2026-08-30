#!/usr/bin/env node
// scripts/bench/hetushu-drive.mjs —— WebBridge 驱动 hetushu 章节抓取（试车台批语料管道第二形态）。
// 原理：作者真实浏览器已过反爬；页内同源 fetch 带站点会话，分块抓 #content 落盘。
// 用法：node scripts/bench/hetushu-drive.mjs [--chunk 25] [--book 4917] [--out .bench/raw/诡秘之主]
// 前置：WebBridge 守护进程+扩展在场；书目录已在页内初始化（脚本会自动检测并初始化，可断点续跑）。
import fs from 'node:fs';
import path from 'node:path';

const DAEMON = 'http://127.0.0.1:10086/command';
const SESSION = 'bench-corpus';
const args = process.argv.slice(2);
const flagVal = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? Number(args[i + 1]) || args[i + 1] : d;
};
const CHUNK = Number(flagVal('--chunk', 25));
const MAX = Number(flagVal('--max', 0)); // >0 时只抓到该章数（调试用）
const BOOK = String(flagVal('--book', '4917')); // hetushu 书号（换书不改代码）
const BOOKURL = '/book/' + BOOK;
const outRoot = String(flagVal('--out', '.bench/raw/诡秘之主'));
fs.mkdirSync(outRoot, { recursive: true });
const outFile = path.join(outRoot, 'chunks.jsonl');

/** 页内执行的抓取代码：依赖 window.__benchToc/__benchIdx（由 SETUP 建立）。 */
const CHUNK_CODE = `(async()=>{
const toc=window.__benchToc;const N=${CHUNK};const out=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const AD=/(和图书|hetushu|hetubook|首发域名|最新网址|无弹窗|请记住本书|手机阅读)/;
for(let k=0;k<N&&window.__benchIdx<toc.length&&!window.__benchAbort;k++){
  const ch=toc[window.__benchIdx];
  try{
    const r=await fetch(ch.u);const html=await r.text();
    const html2=html.replace(/<br[^>]*>/gi,'\\n').replace(/<\\/(p|div|h\\d|li|tr)>/gi,'\\n');
    const doc=new DOMParser().parseFromString(html2,'text/html');
    const el=doc.querySelector('#content');
    const raw=(el?el.textContent:'').replace(/\\r/g,'');
    const paras=raw.split(/\\n+/).map(s=>s.trim()).filter(s=>s&&!AD.test(s));
    if(paras.length&&paras[0].includes(ch.t))paras.shift(); // 页内嵌的「部名+章名」头行
    out.push({order:window.__benchIdx+1,title:ch.t,url:ch.u,chars:paras.join('\\n\\n').length,text:paras.join('\\n\\n'),_diag:{status:r.status,htmlLen:html.length,hasEl:!!el}});
    window.__benchIdx++;           // 仅成功才前进：失败章留位重试，不再永久跳过（0830 纪律对齐：阻塞即停、失败留痕）
    window.__benchErrStreak=0;
  }catch(e){
    window.__benchErr.push({order:window.__benchIdx+1,url:ch.u,err:String(e&&e.message||e)});
    window.__benchErrStreak=(window.__benchErrStreak||0)+1;
    if(window.__benchErrStreak>=10){window.__benchAbort=true;break;}  // 连续 10 章失败阻塞即停
  }
  await sleep(1100+Math.floor(Math.random()*900));
}
return JSON.stringify({done:window.__benchIdx,total:toc.length,abort:!!window.__benchAbort,errs:window.__benchErr.length,errList:window.__benchErr.slice(-3),chunk:out});
})()`;

const SETUP_CODE = `(async()=>{
const r=await fetch('${BOOKURL}/index.html');const html=await r.text();
const links=[...html.matchAll(/href="(${BOOKURL}/\\d+\\.html)"[^>]*>([^<]{1,60})</g)].map(m=>({u:m[1],t:m[2].trim()}));
const uniq=[...new Map(links.map(x=>[x.u,x])).values()];
window.__benchToc=uniq;window.__benchIdx=__IDX__;window.__benchErr=[];window.__benchErrStreak=0;
return JSON.stringify({toc:uniq.length,idx:window.__benchIdx});
})()`;

async function cmd(action, args, timeoutMs = 180_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(DAEMON, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, args, session: SESSION }),
      signal: ctrl.signal,
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error?.message ?? JSON.stringify(j));
    return j.data;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureSetup(doneLines) {
  // 页内状态探测：toc 不存在或 idx 与落盘进度不符则重建
  let probe;
  try {
    probe = await cmd('evaluate', { code: 'JSON.stringify({has:!!window.__benchToc,idx:window.__benchIdx??-1,total:(window.__benchToc||[]).length})' }, 30_000);
  } catch {
    probe = null;
  }
  let idx = doneLines;
  if (probe) {
    try {
      const p = JSON.parse(probe.value);
      if (p.has && p.total > 0 && p.idx === idx) return p;
      idx = p.idx > idx ? p.idx : idx;
    } catch { /* fallthrough */ }
  }
  const setup = await cmd('evaluate', { code: SETUP_CODE.replace('__IDX__', String(idx)) }, 60_000);
  return JSON.parse(setup.value);
}

async function main() {
  const doneLines = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const setup = await ensureSetup(doneLines);
  console.error(`[drive] 目录 ${setup.toc ?? setup.total} 章，起始 idx=${setup.idx ?? 0}（落盘已有 ${doneLines} 章）`);
  let lastErrs = 0;
  for (;;) {
    let data;
    try {
      const res = await cmd('evaluate', { code: CHUNK_CODE }, 300_000);
      data = JSON.parse(res.value);
    } catch (err) {
      console.error(`[drive] 块失败（${String(err.message).slice(0, 120)}），重建页内状态后重试`);
      await ensureSetup(fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).length : 0);
      continue;
    }
    if (data.chunk?.length) {
      fs.appendFileSync(outFile, data.chunk.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
    }
    if (data.errs !== lastErrs) {
      console.error(`[drive] 章节失败累计 ${data.errs}：${JSON.stringify(data.errList ?? [])}`);
      lastErrs = data.errs;
    }
    if (data.abort) {
      console.error(`[drive] 连续 10 章失败，阻塞即停（已落盘章节保留；排除网络/反爬后重跑同一命令续抓）`);
      process.exitCode = 1;
      break;
    }
    console.error(`[drive] 进度 ${data.done}/${data.total}（本块 ${data.chunk?.length ?? 0} 章）`);
    if (data.done >= data.total) break;
    if (MAX > 0 && data.done >= MAX) {
      console.log(`[drive] 到达 --max ${MAX}，提前结束`);
      break;
    }
  }
  console.log(`[drive] 完成：${outFile}`);
}

await main();
