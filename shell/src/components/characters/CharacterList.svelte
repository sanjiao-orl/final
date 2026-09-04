<script lang="ts">
  import { characters } from '../../lib/characters.svelte.js';

  const KIND_LABEL: Record<string, string> = { character: '', faction: '势力', location: '地点', lore: '设定' };
  const timeOf = (rel: string): string => rel.split('/').pop()?.replace(/\.md$/i, '') ?? rel;
</script>

<div class="list">
  <div class="head">
    <span>角色卡 <b>{characters.count}</b></span>
    <span class="head-actions">
      <button
        class="scan"
        disabled={characters.scanning}
        title="角色维确定性补账（零 LLM）：超域疑似/写法变体提案入收件箱，作者裁决去留"
        onclick={() => void characters.scan()}
      >
        {characters.scanning ? '扫描中…' : '扫描'}
      </button>
    </span>
  </div>
  {#if characters.lastScan}
    <div class="scan-note">
      上次扫描：超域疑似 {characters.lastScan.unknownCandidates} / 写法变体 {characters.lastScan.variantSuspects} → 新提案 {characters.lastScan.added}（重复跳过 {characters.lastScan.skipped}）·待裁决见收件箱
    </div>
  {/if}

  {#if characters.entries.length === 0}
    <div class="empty">{characters.scanning ? '扫描中…' : '暂无角色卡——用「扫描」跑一次角色维补账，或由 AI/作者经 character_upsert 登记'}</div>
  {/if}

  {#each characters.entries as c (c.name)}
    <div class="card">
      <div class="meta">
        <span class="name">{c.name}</span>
        {#if c.kind && c.kind !== 'character'}<span class="kind">{KIND_LABEL[c.kind] ?? c.kind}</span>{/if}
        {#if c.role}<span class="role">{c.role}</span>{/if}
        {#if c.faction}<span class="faction">营:{c.faction}</span>{/if}
      </div>
      {#if c.aliases?.length}
        <div class="aliases">别名：{c.aliases.join(' / ')}</div>
      {/if}
      {#if c.description}
        <div class="desc">{c.description}</div>
      {/if}
      {#if c.relations}
        <div class="relations">关系：{c.relations}</div>
      {/if}
      {#if c.states?.length}
        <div class="timeline">
          {#each c.states as s}
            <div class="state"><span class="field">{s.field}</span> {s.value} <span class="since">自 {timeOf(s.since)}</span></div>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .list { height: 100%; overflow: auto; background: var(--panel); font-family: var(--ui-font); position: relative; }
  .head { height: 38px; padding: 0 12px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); font-size: 12px; font-weight: 600; position: sticky; top: 0; background: var(--panel); z-index: 1; }
  .head b { color: var(--accent); }
  .scan { border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; padding: 3px 10px; font-size: 11px; cursor: pointer; }
  .scan:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .scan:disabled { opacity: 0.6; cursor: default; }
  .scan-note { padding: 6px 12px; color: var(--muted); font-size: 10.5px; border-bottom: 1px dashed var(--line); }
  .empty { padding: 28px 14px; color: var(--muted); font-size: 12px; text-align: center; }
  .card { padding: 10px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 4px; }
  .meta { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .name { font-size: 12.5px; font-weight: 700; color: var(--ink); }
  .kind { font-size: 10px; padding: 0 5px; border-radius: 4px; border: 1px solid var(--line); color: var(--muted); }
  .role { font-size: 10.5px; color: var(--accent); }
  .faction { font-size: 10.5px; color: var(--muted); }
  .aliases, .relations { font-size: 10.5px; color: var(--muted); }
  .desc { font-size: 11px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; }
  .timeline { display: flex; flex-direction: column; gap: 2px; border-left: 2px solid var(--line); padding-left: 8px; }
  .state { font-size: 10.5px; color: var(--ink); }
  .field { color: var(--accent); font-weight: 600; margin-right: 4px; }
  .since { color: var(--muted); margin-left: 4px; }
</style>
