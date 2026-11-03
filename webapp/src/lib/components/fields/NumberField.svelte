<script lang="ts">
  import { untrack } from 'svelte';

  let {
    value,
    onSave,
    max,
  }: {
    value: unknown;
    /** 保存回调：收到的是输入框原始字符串 */
    onSave: (raw: string) => void;
    max?: number;
  } = $props();

  let draft = $state('');
  let focused = $state(false);

  const remote = $derived(value == null ? '' : String(value));

  // 仅在远端值变化且未在编辑时同步草稿
  $effect(() => {
    const r = remote;
    untrack(() => {
      if (!focused) draft = r;
    });
  });

  // type=number 不用 bind:value（Svelte 会把值转成 number/null），手动取字符串
  function commit(): void {
    if (draft !== remote) onSave(draft);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
  }
</script>

<input
  class="input num"
  type="number"
  {max}
  step="any"
  value={draft}
  oninput={(e) => (draft = (e.currentTarget as HTMLInputElement).value)}
  onfocus={() => (focused = true)}
  onblur={() => {
    focused = false;
    commit();
  }}
  onkeydown={onKeydown}
/>

<style>
  .num {
    width: 120px;
  }
</style>
