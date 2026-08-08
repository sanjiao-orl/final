// 模块职责：GET /dev 的内嵌联调页（无外部资源）：会话选择/新建、消息列表、输入框，用 fetch POST /chat + ReadableStream 手工解析 SSE。
// token 由服务端直接内嵌（页面本身免鉴权、仅本地服务），供浏览器裸联调用。
export function devPage(token: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>novel core /dev 联调页</title>
<style>
  :root { --bg:#f6f5f2; --panel:#fff; --line:#e3e1da; --accent:#6b4eff; --text:#2a2723; --muted:#8b867c; --ok:#2e9e5b; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:"Microsoft YaHei",system-ui,sans-serif; background:var(--bg); color:var(--text);
         height:100vh; display:flex; flex-direction:column; }
  header { padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--line);
           display:flex; align-items:center; gap:12px; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  header .meta { font-size:12px; color:var(--muted); }
  header .meta.on { color:var(--ok); }
  main { flex:1; display:flex; min-height:0; }
  aside { width:260px; border-right:1px solid var(--line); background:var(--panel); overflow-y:auto; }
  aside .new { display:block; width:100%; padding:10px 12px; border:none; border-bottom:1px solid var(--line);
               background:transparent; cursor:pointer; font:inherit; text-align:left; color:var(--accent); }
  aside .item { padding:10px 12px; border-bottom:1px solid var(--line); cursor:pointer; }
  aside .item:hover { background:#f3f0ff; }
  aside .item.active { background:#ece6ff; }
  aside .item .t { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  aside .item .d { font-size:11px; color:var(--muted); margin-top:2px; }
  section { flex:1; display:flex; flex-direction:column; min-width:0; }
  #messages { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px; }
  .msg { max-width:74%; padding:8px 12px; border-radius:10px; font-size:14px; line-height:1.6;
         white-space:pre-wrap; word-break:break-word; }
  .msg.user { align-self:flex-end; background:var(--accent); color:#fff; }
  .msg.assistant { align-self:flex-start; background:var(--panel); border:1px solid var(--line); }
  .msg.error { align-self:flex-start; background:#fdecec; border:1px solid #f0c4c4; color:#a33; }
  .tool-line { font-size:12px; color:var(--muted); font-family:Consolas,monospace; margin-top:6px;
               white-space:pre-wrap; word-break:break-all; }
  #composer { display:flex; gap:8px; padding:12px 16px; background:var(--panel); border-top:1px solid var(--line); }
  #text { flex:1; resize:none; height:64px; border:1px solid var(--line); border-radius:8px; padding:8px 10px; font:inherit; }
  #send { border:none; background:var(--accent); color:#fff; border-radius:8px; padding:0 22px; cursor:pointer; font:inherit; }
  #send:disabled { opacity:.5; cursor:default; }
</style>
</head>
<body>
<header>
  <h1>novel core /dev</h1>
  <span class="meta" id="status">连接中…</span>
</header>
<main>
  <aside id="sessions"></aside>
  <section>
    <div id="messages"></div>
    <div id="composer">
      <textarea id="text" placeholder="输入内容，Enter 发送 / Shift+Enter 换行"></textarea>
      <button id="send">发送</button>
    </div>
  </section>
</main>
<script>
var TOKEN = '__TOKEN__';
var state = { sessionId: null, streaming: false, toolLines: {} };
var $ = function (id) { return document.getElementById(id); };

function setStatus(text, on) {
  var el = $('status');
  el.textContent = text;
  el.className = 'meta' + (on ? ' on' : '');
}

function api(path) {
  return fetch(path, { headers: { Authorization: 'Bearer ' + TOKEN } }).then(function (res) {
    if (!res.ok) return res.json().then(function (j) { throw new Error((j && j.error) || res.statusText); });
    return res.json();
  });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- 会话列表 ----
function loadSessions() {
  api('/sessions').then(function (j) {
    var box = $('sessions');
    box.innerHTML = '';
    var btn = document.createElement('button');
    btn.className = 'new';
    btn.textContent = '+ 新建会话';
    btn.onclick = function () { state.sessionId = null; renderSessions(); openSession(null); };
    box.appendChild(btn);
    j.sessions.forEach(function (s) { box.appendChild(sessionItem(s)); });
    setStatus('已连接，' + j.sessions.length + ' 个会话', true);
  }).catch(function (e) { setStatus('连接失败: ' + e.message, false); });
}

function sessionItem(s) {
  var div = document.createElement('div');
  div.className = 'item' + (s.id === state.sessionId ? ' active' : '');
  div.dataset.sid = s.id;
  var t = document.createElement('div'); t.className = 't'; t.textContent = s.title || '(无标题)';
  var d = document.createElement('div'); d.className = 'd'; d.textContent = new Date(s.updatedAt).toLocaleString();
  div.appendChild(t); div.appendChild(d);
  div.onclick = function () { state.sessionId = s.id; renderSessions(); openSession(s.id); };
  return div;
}

function renderSessions() {
  var items = $('sessions').children;
  for (var i = 0; i < items.length; i++) items[i].classList.toggle('active', items[i].dataset && items[i].dataset.sid === state.sessionId);
}

// ---- 消息区 ----
function openSession(id) {
  var box = $('messages');
  box.innerHTML = '';
  state.toolLines = {};
  if (!id) { setStatus('新会话', true); return; }
  api('/sessions/' + id).then(function (j) {
    box.innerHTML = '';
    j.messages.forEach(function (m) { renderMessage(m); });
    box.scrollTop = box.scrollHeight;
  }).catch(function (e) { appendBubble('error', '加载会话失败: ' + e.message); });
}

function appendBubble(kind, text) {
  var box = $('messages');
  var div = document.createElement('div');
  div.className = 'msg ' + kind;
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function renderMessage(m) {
  if (m.role === 'user') { appendBubble('user', m.content); return; }
  var el = appendBubble('assistant', m.content || '(空回复)');
  (m.toolCalls || []).forEach(function (tc) {
    var line = document.createElement('div');
    line.className = 'tool-line';
    line.textContent = '[' + tc.name + '] ' + JSON.stringify(tc.args || {});
    el.appendChild(line);
  });
}

// ---- 发送 + SSE 手工解析（EventSource 不支持 POST） ----
function send() {
  var input = $('text');
  var text = input.value.trim();
  if (!text || state.streaming) return;
  state.streaming = true;
  $('send').disabled = true;
  input.value = '';
  appendBubble('user', text);
  var assistantEl = appendBubble('assistant', '');
  state.toolLines = {};
  var body = JSON.stringify({ sessionId: state.sessionId, text: text });

  fetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: body
  }).then(function (res) {
    if (!res.ok) return res.json().then(function (j) { throw new Error((j && j.error) || res.statusText); });
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        buf += decoder.decode(r.value, { stream: true });
        var idx;
        while ((idx = buf.indexOf('\\n\\n')) >= 0) {
          var raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleFrame(raw, assistantEl);
        }
        return pump();
      });
    }
    return pump();
  }).catch(function (e) {
    appendBubble('error', '请求失败: ' + e.message);
  }).finally(function () {
    state.streaming = false;
    $('send').disabled = false;
    if (state.sessionId) loadSessions();
  });
}

function handleFrame(raw, assistantEl) {
  var event = 'message';
  var dataLines = [];
  raw.split('\\n').forEach(function (line) {
    var t = line.trim();
    if (t.indexOf('event:') === 0) event = t.slice(6).trim();
    else if (t.indexOf('data:') === 0) dataLines.push(t.slice(5).trim());
  });
  if (dataLines.length === 0) return;
  var data;
  try { data = JSON.parse(dataLines.join('\\n')); } catch (e) { return; }
  switch (event) {
    case 'text-delta':
      assistantEl.textContent += data.delta || '';
      break;
    case 'tool-call':
      addToolLine(assistantEl, data);
      break;
    case 'tool-result':
      updateToolLine(data);
      break;
    case 'done':
      state.sessionId = data.sessionId;
      assistantEl.textContent += '\\n[完成]';
      break;
    case 'error':
      appendBubble('error', '服务端错误: ' + data.message);
      break;
  }
}

function addToolLine(el, call) {
  var line = document.createElement('div');
  line.className = 'tool-line';
  line.dataset.toolId = call.id || '';
  line.textContent = '[调用工具 ' + call.name + '] ' + JSON.stringify(call.args || {});
  el.appendChild(line);
  state.toolLines[call.id || ''] = line;
}

function updateToolLine(data) {
  var line = state.toolLines[data.id || ''];
  if (!line) return;
  var out = data.result;
  var txt = typeof out === 'string' ? out : JSON.stringify(out);
  if (txt.length > 120) txt = txt.slice(0, 120) + '…';
  line.textContent = '[' + data.name + ' → ' + txt + ']';
}

$('send').onclick = send;
$('text').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
loadSessions();
</script>
</body>
</html>
`.replace('__TOKEN__', token);
}
