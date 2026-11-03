<script lang="ts">
  import { t } from '../../i18n';

  let {
    options = [],
    value,
    coerce,
    onchange,
  }: {
    options: string[];
    value: unknown;
    coerce?: string;
    onchange: (v: unknown[]) => void;
  } = $props();

  // 槽位数量跟随现值数组长度
  const slots = $derived(Array.isArray(value) ? value : []);

  function pick(i: number, raw: string): void {
    const next = [...slots];
    next[i] = coerce === 'int[]' ? Math.trunc(Number(raw)) : raw;
    onchange(next);
  }
</script>

<div class="slots">
  {#each slots as slot, i (i)}
    <label class="slot">
      <span class="idx">#{i + 1}</span>
      <select class="input" value={String(slot ?? '')} onchange={(e) => pick(i, (e.currentTarget as HTMLSelectElement).value)}>
        {#each options as opt (opt)}
          <option value={opt}>{$t(opt)}</option>
        {/each}
      </select>
    </label>
  {/each}
  {#if slots.length === 0}
    <span class="dim">{$t('现值为空，无法渲染槽位')}</span>
  {/if}
</div>

<style>
  .slots {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .slot {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .idx {
    color: var(--faint);
    font-family: var(--mono);
    font-size: 12px;
  }
</style>
