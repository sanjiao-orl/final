<script lang="ts">
  // 设置栏（开放项 2 定稿）：审批模式 ask/auto/yolo、外观（主题/字号/打字机）、
  // 保存与快照（自动保存间隔、采纳前自动快照常开）、暂存与裁决（分流/采纳留痕）。
  import { settings, type ApprovalMode } from '../../lib/settings.svelte.js';

  const APPROVALS: { mode: ApprovalMode; name: string; desc: string }[] = [
    { mode: 'ask', name: 'ask · 逐项询问', desc: 'AI 直调写/删/导出前一律弹审批卡；暂存采纳路径不弹（已有人的裁决）。默认。' },
    { mode: 'auto', name: 'auto · 同类放行', desc: '本会话内同工具同目标放行一次后不再询问，换目标仍询问。' },
    { mode: 'yolo', name: 'yolo · 完全放手', desc: '全部自动放行。所有写入仍强制事前快照（B4 不受模式影响）。' },
  ];
</script>

<div class="group">
  <div class="label">审批模式(B6)</div>
  <div class="approval-cards">
    {#each APPROVALS as a (a.mode)}
      <button class="opt" class:on={settings.approvalMode === a.mode} onclick={() => settings.setApproval(a.mode)}>
        <span class="radio"></span>
        <span class="body">
          <span class="o-name">{a.name}</span>
          <span class="o-desc">{a.desc}</span>
        </span>
      </button>
    {/each}
  </div>
</div>

<div class="group">
  <div class="label">外 观</div>
  <div class="row">
    <div class="r-label">主题</div>
    <div class="seg">
      <button class:on={settings.mode === 'light'} onclick={() => settings.setMode('light')}>纸 · 明</button>
      <button class:on={settings.mode === 'dark'} onclick={() => settings.setMode('dark')}>墨 · 暗</button>
    </div>
  </div>
  <div class="row">
    <div class="r-label">正文字号</div>
    <div class="r-desc">改字号将同步打字机定位与浮动条几何（theme.ts 注释约束）</div>
    <div class="seg">
      {#each [15, 17, 19] as n (n)}
        <button class:on={settings.fontSize === n} onclick={() => settings.setFontSize(n as 15 | 17 | 19)}>{n}</button>
      {/each}
    </div>
  </div>
  <div class="row inline">
    <span class="r-label">打字机滚动(光标锁 42%)</span>
    <label class="switch">
      <input type="checkbox" checked={settings.typewriter} onchange={(e) => settings.setTypewriter(e.currentTarget.checked)} />
      <span class="sl"></span>
    </label>
  </div>
</div>

<div class="group">
  <div class="label">保 存 与 快 照</div>
  <div class="row inline">
    <span class="r-label">自动保存间隔</span>
    <select
      class="inline-sel"
      value={settings.autosaveSec}
      onchange={(e) => settings.setAutosave(Number(e.currentTarget.value) as 30 | 60 | 120)}
    >
      <option value="30">30 秒</option>
      <option value="60">60 秒</option>
      <option value="120">120 秒</option>
    </select>
  </div>
  <div class="row inline">
    <span class="r-label">采纳/危险操作前自动快照(B4)</span>
    <label class="switch">
      <input type="checkbox" checked={settings.snapshotBeforeAdopt} disabled />
      <span class="sl"></span>
    </label>
  </div>
</div>

<div class="group">
  <div class="label">暂 存 与 裁 决</div>
  <div class="row inline">
    <span class="r-label">小改就地浮层，大改进暂存(B1)</span>
    <label class="switch">
      <input type="checkbox" checked={settings.inlineSplit} onchange={(e) => settings.setInlineSplit(e.currentTarget.checked)} />
      <span class="sl"></span>
    </label>
  </div>
  <div class="row inline">
    <span class="r-label">采纳留痕:显示"为何采纳"(B8)</span>
    <label class="switch">
      <input type="checkbox" checked={settings.showInstruction} onchange={(e) => settings.setShowInstruction(e.currentTarget.checked)} />
      <span class="sl"></span>
    </label>
  </div>
</div>

<div class="note">默认值遵循「默认否、可配」——默认全部最保守（审批 ask、快照常开不可关）。</div>

<style>
  .group {
    margin-top: 2px;
  }
  .label {
    font-size: 10.5px;
    letter-spacing: 0.24em;
    color: var(--muted);
    padding-bottom: 7px;
    margin-bottom: 9px;
    border-bottom: 1px solid var(--line);
  }
  .approval-cards {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .opt {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    text-align: left;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 9px 11px;
    cursor: pointer;
    transition: all var(--t-hover);
  }
  .opt:hover {
    border-color: var(--muted);
  }
  .opt.on {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .radio {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 1px solid var(--muted);
    flex: none;
    margin-top: 2px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .opt.on .radio {
    border-color: var(--accent);
  }
  .opt.on .radio::after {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .o-name {
    font-size: 12.5px;
    font-weight: 600;
  }
  .o-desc {
    font-size: 11px;
    color: var(--muted);
    line-height: 1.6;
    margin-top: 2px;
  }
  .row {
    padding: 8px 0;
  }
  .r-label {
    font-size: 12.5px;
    margin-bottom: 2px;
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .r-desc {
    font-size: 11px;
    color: var(--muted);
    line-height: 1.6;
    margin-bottom: 7px;
  }
  .row.inline {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .row.inline .r-label {
    flex: 1;
    margin: 0;
  }
  .seg {
    display: flex;
    border: 1px solid var(--line);
    border-radius: 7px;
    overflow: hidden;
    width: fit-content;
  }
  .seg button {
    height: 27px;
    padding: 0 13px;
    font-size: 12px;
    color: var(--muted);
    border-right: 1px solid var(--line);
    transition: all var(--t-hover);
  }
  .seg button:last-child {
    border-right: none;
  }
  .seg button.on {
    background: var(--accent);
    color: #fff;
  }
  .seg button:not(.on):hover {
    background: color-mix(in srgb, var(--muted) 8%, transparent);
  }
  .switch {
    position: relative;
    width: 32px;
    height: 18px;
    flex: none;
  }
  .switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }
  .switch .sl {
    position: absolute;
    inset: 0;
    border-radius: 9px;
    background: color-mix(in srgb, var(--muted) 35%, transparent);
    transition: background var(--t-hover);
    cursor: pointer;
  }
  .switch input:disabled + .sl {
    cursor: default;
  }
  .switch .sl::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    transition: transform var(--t-hover);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  }
  .switch input:checked + .sl {
    background: var(--accent);
  }
  .switch input:checked + .sl::after {
    transform: translateX(14px);
  }
  .inline-sel {
    height: 27px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel);
    font-size: 12px;
    outline: none;
  }
  .note {
    margin-top: 20px;
    padding: 9px 11px;
    border: 1px dashed color-mix(in srgb, var(--muted) 40%, var(--line));
    border-radius: 8px;
    font-size: 11px;
    color: var(--muted);
    line-height: 1.7;
  }
</style>
