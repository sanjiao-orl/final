<script lang="ts">
  // 工具栏（B3/B10）：当前会话全部工具调用卡片流，独立分栏不挤消息流。
  import { chat } from '../../lib/chat.svelte.js';
  import ToolCard from './ToolCard.svelte';

  const tools = $derived(chat.messages.flatMap((m) => m.tools ?? []));
</script>

{#if tools.length === 0}
  <p class="hint">还没有工具调用。对 AI 下指令后，读章/搜索/统计等工具调用会以卡片列在这里，可点开就地审阅参数与结果（B3/B10）。</p>
{/if}
{#each tools as t (t.id)}
  <ToolCard tool={t} />
{/each}

<style>
  .hint {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.7;
  }
</style>
