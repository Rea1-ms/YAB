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

  // 当前值即有序优先级（空串/缺失视为空列表），保存一律存 string[]
  const current = $derived(toStringArray(value));
  const remaining = $derived(options.filter((o) => !current.includes(o)));

  function move(i: number, delta: number): void {
    const j = i + delta;
    if (j < 0 || j >= current.length) return;
    const next = [...current];
    [next[i], next[j]] = [next[j], next[i]];
    onchange(next);
  }

  function remove(i: number): void {
    onchange(current.filter((_, idx) => idx !== i));
  }

  function add(item: string): void {
    onchange([...current, item]);
  }
</script>

<div class="wrap">
  <div class="chips">
    {#each current as item, i (item + i)}
      <span class="chip static">
        <span class="idx">{i + 1}</span>
        {item}
        <button class="op" type="button" title="上移" disabled={i === 0} onclick={() => move(i, -1)}>↑</button>
        <button class="op" type="button" title="下移" disabled={i === current.length - 1} onclick={() => move(i, 1)}>↓</button>
        <button class="op" type="button" title="移除" onclick={() => remove(i)}>×</button>
      </span>
    {/each}
    {#if current.length === 0}
      <span class="dim">尚未设置优先级</span>
    {/if}
  </div>
  {#if remaining.length > 0}
    <div class="add-row">
      <span class="dim">可添加：</span>
      {#each remaining as item (item)}
        <button class="chip" type="button" title="点击添加" onclick={() => add(item)}>+ {item}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .chips,
  .add-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .chip.static {
    cursor: default;
    gap: 4px;
  }
  .idx {
    color: var(--faint);
    font-size: 11px;
    font-family: var(--mono);
  }
  .op {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 12px;
    padding: 0 2px;
    line-height: 1;
  }
  .op:hover:not(:disabled) {
    color: var(--accent);
  }
  .op:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
</style>
