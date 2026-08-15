<script lang="ts">
  // 审阅报告（WS-17 壳内审阅出口）：全书 scan_quality + 账本确定性诊断的逐章报告。
  // 形态对齐暂存全览：右侧固定全览覆盖层，Esc/× 关闭；BLOCKER 标红，关掉后顶栏徽标仍在。
  import { iconSvg } from '../../lib/icons.js';
  import { review, SCENE_POOL_MIN, type FindingSeverity, type ScanSeverity } from '../../lib/review.svelte.js';
  import { work } from '../../lib/work.svelte.js';

  const SEV_LABEL: Record<FindingSeverity, string> = {
    BLOCKER: 'BLOCKER',
    MAJOR: 'MAJOR',
    MODERATE: 'MODERATE',
    MINOR: 'MINOR',
  };
  const SCAN_SEV_LABEL: Record<ScanSeverity, string> = {
    fail: '超标',
    warn: '临界',
    pass: '达标',
    info: '参考',
  };

  function chapterBase(relPath: string): string {
    return relPath.split(/[\\/]/).pop()?.replace(/\.md$/, '') ?? relPath;
  }

  // 反馈#4：全书章数（扫描进度文案用；结构树未加载为 0 → 文案回落"可能需要数十秒"）。
  const chapterCount = $derived(work.structure.reduce((n, v) => n + v.children.length, 0));

  /** 处理中进度文案：便宜档扫描按章数写，拿不到写兜底；贵档冷读按章计费。 */
  const busyText = $derived(
    review.mode === 'premium'
      ? '冷读审阅中（LLM 按章计费），需要数秒至数十秒…'
      : chapterCount > 0
        ? `扫描中，全书约 ${chapterCount} 章，需要数十秒…`
        : '扫描中，可能需要数十秒…',
  );

  function timeOf(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') review.close();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overview" role="dialog" aria-modal="true" aria-label="审阅报告">
  <div class="head">
    <span class="title">
      审阅报告{#if review.blockerTotal > 0}<i class="n danger">{review.blockerTotal}</i>{/if}
    </span>
    {#if review.report}
      <span class="hint">扫于 {timeOf(review.report.ranAt)} · 确定性检查（零 LLM 成本）</span>
    {:else}
      <span class="hint">全书扫描 + 账本诊断 · 确定性检查（零 LLM 成本）</span>
    {/if}
    <div class="actions">
      {#if review.running}<span class="busy" title="处理完成前按钮暂不可用">{busyText}</span>{/if}
      <button
        class="btn sm"
        disabled={review.running}
        onclick={() => void review.run()}
        title={review.running ? '正在处理，完成后可点击' : '重跑全书扫描与账本诊断（处理完问题后重跑，BLOCKER 清零徽标即消失）'}
      >重跑</button>
      <button class="icon-btn" onclick={() => review.close()} aria-label="关闭审阅报告">{@html iconSvg('close', 14, 2)}</button>
    </div>
  </div>

  <!-- 反馈#4：三档说明（名字 + 干什么 + 贵不贵），点之前知道会发生什么 -->
  <div class="tiers">
    <div class="tier"><b>① 全书扫描</b><span class="t-desc">scan_quality 逐章量化「去 AI 味」指标，纯本地确定性计算，免费。</span></div>
    <div class="tier"><b>② 账本诊断</b><span class="t-desc">ledger_diagnostics 四维账本确定性检查 + 问题日志 BLOCKER 计数，免费。</span></div>
    <div class="tier"><b>③ 贵档冷读</b><span class="t-desc">对当前章 LLM 冷读审阅（只注入单章 + 账本切片），走主笔模型，按章计费、需数秒至数十秒。</span></div>
  </div>

  <div class="body">
    {#if review.error}
      <div class="err-zone" role="alert">
        <span>{review.error}</span>
        <button onclick={() => review.dismissError()} aria-label="关闭错误">×</button>
      </div>
    {/if}
    {#if review.running && !review.report}
      <div class="empty">{busyText}</div>
    {:else if review.report}
      {@const r = review.report}

      <div class="summary">
        <span class="pill sev-BLOCKER" class:off={r.counts.BLOCKER === 0}>BLOCKER {r.counts.BLOCKER}</span>
        <span class="pill sev-MAJOR" class:off={r.counts.MAJOR === 0}>MAJOR {r.counts.MAJOR}</span>
        <span class="pill sev-MODERATE" class:off={r.counts.MODERATE === 0}>MODERATE {r.counts.MODERATE}</span>
        {#if r.issueLogBlockers > 0}
          <span class="pill sev-BLOCKER" title="问题日志（CR 格式）里的 BLOCKER 条数">日志 BLOCKER {r.issueLogBlockers}</span>
        {/if}
        <span class="pill scan" class:off={r.scanFail === 0}>指标超标 {r.scanFail}</span>
        <span class="pill scan-warn" class:off={r.scanWarn === 0}>指标临界 {r.scanWarn}</span>
        {#if work.current}
          <button
            class="btn sm premium"
            disabled={review.running}
            onclick={() => void review.runPremium(work.current!.relPath)}
            title={review.running ? '正在处理，完成后可点击' : '贵档审阅当前章（LLM 冷读，只注入单章，按章计费）'}
          >
            {review.running ? '处理中…' : '贵档审阅当前章'}
          </button>
        {/if}
      </div>

      {#if r.clean}
        <div class="empty clean">
          干净 ✓ —— 无超标扫描指标、无账本诊断条目、无书级违规。
        </div>
      {/if}

      <!-- 书级：场景轮换池 / 连续同场景 / 跨章模板段落 / 账本级诊断 -->
      <div class="card">
        <div class="card-head">
          <span class="ch">书级指标</span>
          <span class="meta-note" class:warn={r.book.scenePool.length < SCENE_POOL_MIN}>
            场景轮换池 {r.book.scenePool.length} 个{#if r.book.scenePool.length < SCENE_POOL_MIN}（建议 ≥{SCENE_POOL_MIN}）{/if}
          </span>
        </div>
        <div class="card-body">
          {#each r.bookFindings as f (f.code + f.message)}
            <div class="finding">
              <span class="pill sev-{f.severity}">{SEV_LABEL[f.severity]}</span>
              <span class="fmsg">{f.message}</span>
            </div>
          {/each}
          {#each r.book.sceneContinuity as v (v.scene)}
            <div class="finding">
              <span class="pill sev-MAJOR">连续同场景</span>
              <span class="fmsg">「{v.scene}」连续出现 {v.chapters.length} 章：{v.chapters.map(chapterBase).join('、')}</span>
            </div>
          {/each}
          {#each r.book.templateParagraphs as t (t.opening)}
            <div class="finding">
              <span class="pill sev-MAJOR">模板段落</span>
              <span class="fmsg">「{t.opening}…」跨章重复：{t.chapters.map(chapterBase).join('、')}</span>
            </div>
          {/each}
          {#if r.bookFindings.length === 0 && r.book.sceneContinuity.length === 0 && r.book.templateParagraphs.length === 0}
            <div class="ok-line">书级无违规。</div>
          {/if}
        </div>
      </div>

      <!-- 逐章 -->
      {#each r.chapters as c (c.relPath)}
        <div class="card" class:clean-ch={c.metrics.length === 0 && c.findings.length === 0 && c.premium.length === 0}>
          <div class="card-head">
            <span class="ch">{c.title}</span>
            {#if c.findings.some((f) => f.severity === 'BLOCKER') || c.premium.some((f) => f.severity === 'BLOCKER')}
              <span class="pill sev-BLOCKER">BLOCKER</span>
            {/if}
            {#if c.metrics.length === 0 && c.findings.length === 0 && c.premium.length === 0}
              <span class="meta-note">干净</span>
            {/if}
          </div>
          {#if c.metrics.length > 0 || c.findings.length > 0 || c.premium.length > 0}
            <div class="card-body">
              {#each c.findings as f (f.code + f.message)}
                <div class="finding">
                  <span class="pill sev-{f.severity}">{SEV_LABEL[f.severity]}</span>
                  <span class="fmsg">{f.message}</span>
                </div>
              {/each}
              {#if c.premium.length > 0}
                <div class="premium-head">贵档审阅</div>
                {#each c.premium as f, i (`${f.severity}-${f.quote}-${i}`)}
                  <div class="finding premium">
                    <span class="pill sev-{f.severity}">{SEV_LABEL[f.severity]}</span>
                    <span class="fmsg">
                      <span class="quote">「{f.quote}」</span> {f.why}
                      {#if f.suggestion}<span class="sug">建议：{f.suggestion}</span>{/if}
                    </span>
                  </div>
                {/each}
              {/if}
              {#each c.metrics as m (m.key)}
                <div class="metric">
                  <span class="pill scan-{m.severity}">{SCAN_SEV_LABEL[m.severity]}</span>
                  <span class="mlabel">{m.label} <b>{m.count}</b></span>
                  <span class="mstd">{m.standard}</span>
                </div>
                {#each m.hits.slice(0, 3) as h (h.line)}
                  <div class="hit">L{h.line} · {h.text}</div>
                {/each}
                {#if m.more}<div class="hit">…另有 {m.more} 条命中</div>{/if}
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {:else}
      <div class="empty">
        尚无报告。点击右上角「重跑」开始扫描。
        {#if work.current}
          <div class="empty-actions">
            <button
              class="btn sm premium"
              disabled={review.running}
              onclick={() => void review.runPremium(work.current!.relPath)}
              title={review.running ? '正在处理，完成后可点击' : '不跑便宜档，直接贵档审阅当前章（LLM 冷读，只注入单章，按章计费）'}
            >
              {review.running ? '处理中…' : '贵档审阅当前章'}
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .overview {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(760px, calc(100vw - var(--tree-w) - var(--rail-w) - 80px));
    z-index: 90;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border-left: 1px solid var(--line);
    box-shadow: var(--shadow-pop);
    font-family: var(--ui-font);
  }
  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    height: 46px;
    border-bottom: 1px solid var(--line);
    user-select: none;
  }
  .title {
    font-size: 13px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .title .n {
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9px;
    color: #fff;
    font-size: 10.5px;
    line-height: 18px;
    text-align: center;
  }
  .title .n.danger {
    background: var(--danger);
  }
  .hint {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }
  .actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .busy {
    color: var(--accent);
    font-size: 12px;
  }
  /* 反馈#4：三档说明 + 内嵌错误 + 处理中提示的排版 */
  .tiers {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 9px 14px;
    border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--muted) 4%, transparent);
  }
  .tier {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 11px;
    line-height: 1.6;
  }
  .tier b {
    flex: none;
    color: var(--ink);
    font-weight: 600;
    white-space: nowrap;
  }
  .tier .t-desc {
    color: var(--muted);
  }
  .err-zone {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 10px;
    border: 1px solid var(--danger);
    border-radius: 7px;
    background: color-mix(in srgb, var(--danger) 9%, var(--panel));
    color: var(--danger);
    font-size: 12px;
    line-height: 1.6;
  }
  .err-zone button {
    flex: none;
    font-size: 14px;
    line-height: 1;
    padding: 0 3px;
    color: var(--danger);
  }
  .btn {
    height: 26px;
    padding: 0 10px;
    font-size: 12px;
    border-radius: 6px;
    border: 1px solid var(--line);
    transition: all var(--t-hover);
    white-space: nowrap;
  }
  .btn:hover:not(:disabled) {
    background: var(--paper);
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .icon-btn {
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 5px;
    color: var(--muted);
    transition: background var(--t-hover), color var(--t-hover);
  }
  .icon-btn:hover {
    background: color-mix(in srgb, var(--muted) 12%, transparent);
    color: var(--ink);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .empty {
    border: 1px dashed color-mix(in srgb, var(--muted) 40%, var(--line));
    border-radius: 8px;
    padding: 30px;
    text-align: center;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.9;
  }
  .empty.clean {
    border-color: color-mix(in srgb, var(--ok) 45%, var(--line));
    color: var(--ok);
  }
  .summary {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .pill {
    flex: none;
    height: 18px;
    padding: 0 7px;
    border-radius: 9px;
    font-size: 10.5px;
    line-height: 18px;
    border: 1px solid var(--line);
    color: var(--muted);
    white-space: nowrap;
  }
  .pill.off {
    opacity: 0.45;
  }
  .pill.sev-BLOCKER {
    background: var(--danger);
    border-color: var(--danger);
    color: #fff;
    font-weight: 600;
  }
  .pill.sev-BLOCKER.off {
    background: transparent;
    color: var(--muted);
    border-color: var(--line);
    font-weight: 400;
  }
  .pill.sev-MAJOR {
    color: var(--status-draft);
    border-color: color-mix(in srgb, var(--status-draft) 45%, var(--line));
  }
  .pill.sev-MAJOR:not(.off) {
    background: var(--warn-bg);
  }
  .pill.sev-MODERATE,
  .pill.sev-MINOR {
    color: var(--muted);
  }
  .pill.scan,
  .pill.scan-fail {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, var(--line));
  }
  .pill.scan-warn {
    color: var(--status-draft);
    border-color: color-mix(in srgb, var(--status-draft) 45%, var(--line));
  }
  .summary .btn.premium {
    margin-left: 4px;
  }
  .empty-actions {
    margin-top: 10px;
  }
  .premium-head {
    margin-top: 2px;
    font-size: 11px;
    font-weight: 600;
    color: var(--status-draft);
    letter-spacing: 0.05em;
  }
  .finding.premium .quote {
    color: var(--ink);
    background: color-mix(in srgb, var(--status-draft) 10%, transparent);
    border-radius: 4px;
    padding: 0 4px;
  }
  .finding.premium .sug {
    display: block;
    margin-left: 26px;
    color: var(--muted);
    font-size: 11px;
  }
  .card {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
  }
  .card.clean-ch {
    opacity: 0.72;
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 11.5px;
    color: var(--muted);
  }
  .card.clean-ch .card-head {
    border-bottom: none;
  }
  .ch {
    font-family: var(--body-font);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    letter-spacing: 0.04em;
  }
  .meta-note {
    font-size: 11px;
    color: var(--muted);
  }
  .meta-note.warn {
    color: var(--status-draft);
  }
  .card-body {
    padding: 8px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .finding {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 12px;
    line-height: 1.7;
  }
  .fmsg {
    color: var(--ink);
    word-break: break-word;
  }
  .ok-line {
    font-size: 12px;
    color: var(--ok);
  }
  .metric {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 12px;
    line-height: 1.7;
  }
  .mlabel {
    color: var(--ink);
  }
  .mlabel b {
    font-variant-numeric: tabular-nums;
  }
  .mstd {
    color: var(--muted);
    font-size: 11px;
  }
  .hit {
    margin-left: 26px;
    font-size: 11px;
    color: var(--muted);
    font-family: var(--body-font);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
