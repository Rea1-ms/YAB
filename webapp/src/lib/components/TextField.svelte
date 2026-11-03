<script lang="ts">
  import { untrack } from 'svelte';

  let {
    value,
    onSave,
    placeholder = '',
    type = 'text',
  }: {
    value: unknown;
    /** 保存回调：收到的是未经转换的原始字符串 */
    onSave: (raw: string) => void;
    placeholder?: string;
    type?: string;
  } = $props();

  let draft = $state('');
  let focused = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const remote = $derived(value == null ? '' : String(value));

  // 仅在远端值变化且未在编辑时同步草稿，避免打断输入
  $effect(() => {
    const r = remote;
    untrack(() => {
      if (!focused) draft = r;
    });
  });

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (draft !== remote) onSave(draft);
    }, 500);
  }

  function onBlur(): void {
    focused = false;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (draft !== remote) onSave(draft);
  }
</script>

<input
  class="input"
  {type}
  {placeholder}
  bind:value={draft}
  oninput={schedule}
  onfocus={() => (focused = true)}
  onblur={onBlur}
/>
