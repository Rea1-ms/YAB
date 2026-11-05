<script lang="ts">
  import { toStringArray } from './shared';
  import { t } from '../../i18n';

  let {
    value,
    placeholder = '输入后回车添加',
    onchange,
  }: {
    value: unknown;
    placeholder?: string;
    onchange: (v: string[]) => void;
  } = $props();

  const items = $derived(toStringArray(value));
  let input = $state('');

  function add(): void {
    const v = input.trim();
    if (!v) return;
    if (!items.includes(v)) onchange([...items, v]);
    input = '';
  }

  function remove(i: number): void {
    onchange(items.filter((_, idx) => idx !== i));
  }
</script>

<div class="wrap">
  <div class="chips">
    {#each items as item, i (item + i)}
      <span class="chip static">
        {item}
        <button class="op" type="button" title={$t('移除')} onclick={() => remove(i)}>×</button>
      </span>
    {/each}
    {#if items.length === 0}
      <span class="dim">{$t('暂无条目')}</span>
    {/if}
  </div>
  <input
    class="input"
    placeholder={$t(placeholder)}
    bind:value={input}
    onkeydown={(e) => e.key === 'Enter' && add()}
  />
</div>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .chip.static {
    cursor: default;
    gap: 4px;
  }
  .op {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 13px;
    padding: 0 2px;
    line-height: 1;
  }
  .op:hover {
    color: var(--danger);
  }
  .wrap .input {
    max-width: 280px;
  }
</style>
