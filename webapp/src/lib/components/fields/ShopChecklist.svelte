<script lang="ts">
  import { currencyLabel, toFlagArray } from './shared';
  import type { ShopRow } from '../../types';

  let {
    rows = [],
    value,
    onchange,
  }: {
    rows: ShopRow[];
    value: unknown;
    onchange: (v: number[]) => void;
  } = $props();

  // 值为与 options 下标对齐的 0/1 标志数组
  const flags = $derived(toFlagArray(value, rows.length));

  function toggle(i: number): void {
    const next = [...flags];
    next[i] = next[i] === 1 ? 0 : 1;
    onchange(next);
  }
</script>

<div class="grid">
  {#each rows as row, i (i)}
    <label class="cell">
      <input type="checkbox" checked={flags[i] === 1} onchange={() => toggle(i)} />
      <span class="name">{row.name}</span>
      <span class="price">{row.price} {currencyLabel(row.currency)}</span>
    </label>
  {/each}
  {#if rows.length === 0}
    <span class="dim">暂无商品数据</span>
  {/if}
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 2px 16px;
  }
  .cell {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 13px;
    padding: 3px 0;
    min-width: 0;
  }
  .cell input {
    accent-color: var(--accent);
    cursor: pointer;
    flex: none;
  }
  .name {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .price {
    color: var(--muted);
    font-size: 12px;
    flex: none;
    margin-left: auto;
  }
</style>
