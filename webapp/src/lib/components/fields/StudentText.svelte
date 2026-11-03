<script lang="ts">
  import { untrack } from 'svelte';
  import { toStringArray } from './shared';
  import { t } from '../../i18n';

  let {
    options = [],
    value,
    onchange,
  }: {
    options: string[];
    value: unknown;
    onchange: (v: string[]) => void;
  } = $props();

  let draft = $state('');
  let addName = $state('');
  let focused = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  // 远端值用逗号连接显示（参考旧 GUI）
  const remote = $derived(toStringArray(value).join(','));

  // 仅在远端值变化且未在编辑时同步草稿
  $effect(() => {
    const r = remote;
    untrack(() => {
      if (!focused) draft = r;
    });
  });

  function parseDraft(s: string): string[] {
    return s
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter((x) => x !== '');
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (draft !== remote) onchange(parseDraft(draft));
    }, 500);
  }

  function onBlur(): void {
    focused = false;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (draft !== remote) onchange(parseDraft(draft));
  }

  function addStudent(): void {
    const name = addName.trim();
    if (!name) return;
    const cur = toStringArray(value);
    if (cur.includes(name)) {
      addName = '';
      return;
    }
    onchange([...cur, name]);
    addName = '';
  }
</script>

<div class="wrap">
  <input
    class="input"
    placeholder={$t('学生名，逗号分隔')}
    bind:value={draft}
    oninput={schedule}
    onfocus={() => (focused = true)}
    onblur={onBlur}
  />
  <div class="add-row">
    <input
      class="input"
      placeholder={$t('从列表选择或输入学生名…')}
      list="student-options"
      bind:value={addName}
      onkeydown={(e) => e.key === 'Enter' && addStudent()}
    />
    <datalist id="student-options">
      {#each options as s (s)}
        <option value={s}></option>
      {/each}
    </datalist>
    <button class="btn" type="button" onclick={addStudent}>{$t('添加')}</button>
  </div>
</div>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .wrap :global(.input) {
    max-width: 360px;
  }
  .add-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .add-row .input {
    max-width: 260px;
  }
</style>
