<script lang="ts">
  // 设置栏（开放项 2 定稿）：审批模式 ask/auto/yolo、外观（主题/字号/打字机）、
  // 保存与快照（自动保存间隔、采纳前自动快照常开）、暂存与裁决（分流/采纳留痕）。
  // 第二步新增：作品目录（config.json workDir）+ 模型配置（BYOK 双档 LLM_*），保存后重启 core 生效。
  import { open } from '@tauri-apps/plugin-dialog';
  import { settings, type ApprovalMode } from '../../lib/settings.svelte.js';
  import type { ResolvedField } from '../../lib/settings.svelte.js';

  const APPROVALS: { mode: ApprovalMode; name: string; desc: string }[] = [
    { mode: 'ask', name: 'ask · 逐项询问', desc: 'AI 直调写/删/导出前一律弹审批卡；暂存采纳路径不弹（已有人的裁决）。默认。' },
    { mode: 'auto', name: 'auto · 同类放行', desc: '本会话内同工具同目标放行一次后不再询问，换目标仍询问。' },
    { mode: 'yolo', name: 'yolo · 完全放手', desc: '全部自动放行。所有写入仍强制事前快照（B4 不受模式影响）。' },
  ];

  const ASSIGNS: { purpose: 'writing' | 'background' | 'review'; name: string }[] = [
    { purpose: 'writing', name: '写作档' },
    { purpose: 'background', name: '后台档' },
    { purpose: 'review', name: '审阅档' },
  ];

  const SRC_LABEL: Record<ResolvedField['source'], string> = {
    config: '配置',
    env: '环境变量',
    default: '缺省',
  };

  /** 占位符：当前生效值 + 来源；无值给回落提示。 */
  function ph(f: ResolvedField | undefined, hint: string): string {
    if (!f) return hint;
    return f.value ? `当前生效（${SRC_LABEL[f.source]}）：${f.value}` : `当前生效（缺省）：${hint}`;
  }

  async function pickWorkDir(): Promise<void> {
    try {
      const dir = await open({ directory: true, title: '选择作品目录' });
      if (typeof dir === 'string' && dir) settings.appWorkDir = dir;
    } catch {
      settings.appError = '选择文件夹失败（非 Tauri 环境？）';
    }
  }
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
  <div class="label">作 品 目 录</div>
  <div class="row">
    <div class="r-label">当前作品目录</div>
    <div class="r-desc">
      {settings.configStatus
        ? `${settings.configStatus.workDir.value}（来源：${SRC_LABEL[settings.configStatus.workDir.source]}）`
        : 'core 启动时决定（未加载）'}
    </div>
    <div class="row-inline">
      <input class="text" placeholder="留空 = 默认目录" bind:value={settings.appWorkDir} aria-label="配置的作品目录" />
      <button class="btn" onclick={() => void pickWorkDir()}>选择文件夹…</button>
    </div>
    <div class="r-desc">换书/换目录不用再改环境变量：填好后保存配置并「立即重启 core」即切换。</div>
  </div>
</div>

<div class="group">
  <div class="label">模 型 预 设（按用途分配）</div>
  {#each settings.appLlmPresets as preset, i (preset.id)}
    <div class="preset-card">
      <div class="preset-head">
        <span class="preset-title">{preset.name || `预设 ${i + 1}`}</span>
        <button class="btn mini" onclick={() => settings.removeLlmPreset(preset.id)}>删除</button>
      </div>
      <div class="row">
        <div class="r-label">名称</div>
        <input class="text" bind:value={preset.name} placeholder="如：主笔模型" />
      </div>
      <div class="row">
        <div class="r-label">Base URL</div>
        <input class="text" bind:value={preset.baseUrl} placeholder="https://…/v1" />
      </div>
      <div class="row">
        <div class="r-label">API Key</div>
        <input class="text" type="password" bind:value={preset.apiKey} placeholder="sk-…" />
      </div>
      <div class="row">
        <div class="r-label">模型</div>
        <input class="text" bind:value={preset.model} placeholder="模型 id" />
      </div>
    </div>
  {/each}
  <div class="row-inline">
    <button class="btn" onclick={() => settings.addLlmPreset()}>+ 添加预设</button>
  </div>

  <div class="sub-label">用途分配</div>
  {#each ASSIGNS as a (a.purpose)}
    <div class="row inline">
      <span class="r-label">{a.name}</span>
      <select
        class="inline-sel"
        value={settings.appLlmAssign[a.purpose] ?? ''}
        onchange={(e) => settings.setLlmAssign(a.purpose, e.currentTarget.value || undefined)}
      >
        <option value="">未指定（回退第一预设）</option>
        {#each settings.appLlmPresets as p (p.id)}
          <option value={p.id}>{p.name || p.id}</option>
        {/each}
      </select>
    </div>
  {/each}

  <div class="row-inline">
    <button class="btn primary" disabled={settings.saving} onclick={() => void settings.saveAppConfig()}>
      {settings.saving ? '保存中…' : '保存配置'}
    </button>
    <button class="btn" disabled={settings.restarting || settings.saving} onclick={() => void settings.restartCore()}>
      {settings.restarting ? '重启中…' : '立即重启 core'}
    </button>
  </div>
  {#if settings.appNotice}
    <div class="status ok-line"><span>{settings.appNotice}</span><button onclick={() => settings.dismissAppNotice()} aria-label="关闭">×</button></div>
  {/if}
  {#if settings.appError}
    <div class="status err-line"><span>{settings.appError}</span><button onclick={() => settings.dismissAppError()} aria-label="关闭">×</button></div>
  {/if}
  <div class="note">每个预设的 名称/Base URL/API Key/模型 均必填，保存前会校验。API Key 明文存储于本机应用数据目录（config.json），纯本地单用户使用。保存后点「立即重启 core」生效，无需重启应用。</div>
</div>

<div class="group">
  <div class="label">模 型 配 置（兼容回退）</div>
  <div class="r-desc">以下四字段仅在「无任何预设」时生效：写作档→LLM_MODEL，后台/审阅档→LLM_MODEL_CHEAP（缺省同写作档）。已配置预设时忽略以下字段。</div>
  <div class="row">
    <div class="r-label">Base URL</div>
    <input class="text" placeholder={ph(settings.configStatus?.baseUrl, '回落环境变量 LLM_BASE_URL')} bind:value={settings.appBaseUrl} />
  </div>
  <div class="row">
    <div class="r-label">API Key</div>
    <input class="text" type="password" placeholder={ph(settings.configStatus?.apiKey, '回落环境变量 LLM_API_KEY')} bind:value={settings.appApiKey} />
  </div>
  <div class="row">
    <div class="r-label">写作档模型</div>
    <input class="text" placeholder={ph(settings.configStatus?.model, '回落环境变量 LLM_MODEL')} bind:value={settings.appModel} />
  </div>
  <div class="row">
    <div class="r-label">后台档模型（便宜）</div>
    <input class="text" placeholder={ph(settings.configStatus?.modelCheap, '回落环境变量 LLM_MODEL_CHEAP，再缺省同写作档')} bind:value={settings.appModelCheap} />
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
    <span class="r-label" title="开 = 小改就地浮层；关 = 全部进暂存区">小改就地浮层(默认进暂存区)</span>
    <label class="switch">
      <input type="checkbox" checked={settings.inlineSplit} onchange={(e) => settings.setInlineSplit(e.currentTarget.checked)} />
      <span class="sl"></span>
    </label>
  </div>
  <div class="r-desc">开：小改就地浮层；关（默认）：全部进暂存区。</div>
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
  .row-inline {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 7px;
  }
  .text {
    flex: 1;
    min-width: 0;
    height: 27px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel);
    font-size: 12px;
    color: var(--ink);
    outline: none;
  }
  .text:focus {
    border-color: var(--accent);
  }
  .btn {
    height: 27px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel);
    color: var(--ink);
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    transition: all var(--t-hover);
  }
  .btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .btn.primary:hover:not(:disabled) {
    opacity: 0.88;
    color: #fff;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 6px 0;
    padding: 6px 9px;
    border-radius: 6px;
    font-size: 11px;
    line-height: 1.5;
  }
  .status button {
    font-size: 13px;
    padding: 0 3px;
  }
  .ok-line {
    background: color-mix(in srgb, var(--ok) 10%, var(--panel));
    color: var(--ok);
    border: 1px solid var(--ok);
  }
  .err-line {
    background: color-mix(in srgb, var(--danger) 10%, var(--panel));
    color: var(--danger);
    border: 1px solid var(--danger);
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
  .sub-label {
    margin: 12px 0 6px;
    font-size: 11px;
    letter-spacing: 0.12em;
    color: var(--muted);
  }
  .preset-card {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 9px 11px;
    margin-bottom: 8px;
    background: color-mix(in srgb, var(--panel) 55%, transparent);
  }
  .preset-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }
  .preset-title {
    font-size: 12.5px;
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .btn.mini {
    height: 22px;
    padding: 0 8px;
    font-size: 11px;
    flex: none;
  }
</style>
