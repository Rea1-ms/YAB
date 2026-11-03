<script lang="ts">
  import { toStringArray } from './shared';

  let {
    options = [],
    value,
    onchange,
  }: {
    options: string[];
    value: unknown;
    onchange: (v: string[]) => void;
  } = $props();

  const selected = $derived(new Set(toStringArray(value)));

  function toggle(item: string): void {
    const next = new Set(selected);
    if (next.has(item)) next.delete(item);
    else next.add(item);
    // 按选项顺序输出，保持稳定
    onchange(options.filter((o) => next.has(o)));
  }
</script>

<div class="grid">
  {#each options as opt (opt)}
    <label class="cell">
      <input type="checkbox" checked={selected.has(opt)} onchange={() => toggle(opt)} />
      <span class="name">{opt}</span>
    </label>
  {/each}
  {#if options.length === 0}
    <span class="dim">暂无可选项</span>
  {/if}
</div>

<style>
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 14px;
  }
  .cell {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-size: 13px;
    padding: 3px 0;
  }
  .cell input {
    accent-color: var(--accent);
    cursor: pointer;
  }
  .name {
    color: var(--text);
  }
</style>
