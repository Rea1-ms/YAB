<script lang="ts">
  import { getDirStores } from '../stores';
  import PanelAccordion from '../components/fields/PanelAccordion.svelte';

  let { dir }: { dir: string } = $props();
  // dir 由外层 {#key dir} 保证变化时重挂载，初始化读取即最终值
  // svelte-ignore state_referenced_locally
  const { args, panels } = getDirStores(dir);

  const configPanels = $derived(($panels?.panels ?? []).filter((p) => p.page === 'config'));
</script>

<div class="page">
  {#if !$panels}
    <div class="placeholder dim">面板加载中…</div>
  {:else if configPanels.length === 0}
    <div class="placeholder dim">暂无配置面板</div>
  {:else}
    <div class="list">
      {#each configPanels as p, i (p.id)}
        <PanelAccordion {dir} panel={p} args={$args ?? {}} defaultOpen={i === 0} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .page {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    overflow: auto;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .placeholder {
    margin: auto;
  }
</style>
