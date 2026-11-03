<script lang="ts">
  import { untrack } from 'svelte';
  import type { StudentStages } from '../../types';

  let {
    value,
    normal = true,
    studentStages = [],
    onSave,
  }: {
    value: unknown; // 逗号分隔字符串 "1-1-1,1-2-3"
    normal: boolean; // 普通关（关卡 1..5、次数 1..3）或困难关（关卡 1..3、次数 1..3/max）
    studentStages: StudentStages[];
    /** 保存：走 set_sweep RPC，成功返回 true */
    onSave: (raw: string) => Promise<boolean>;
  } = $props();

  const remote = $derived(String(value ?? '').trim());
  const tokens = $derived(
    remote
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x !== ''),
  );

  let draft = $state('');
  let focused = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  // 自由文本草稿：未编辑时跟随远端
  $effect(() => {
    const r = remote;
    untrack(() => {
      if (!focused) draft = r;
    });
  });

  // —— 添加行 ——
  // normal 来自面板 schema，挂载后不变，仅取初始值
  // svelte-ignore state_referenced_locally
  const REGIONS = Array.from({ length: 30 }, (_, i) => String(i + 1));
  // svelte-ignore state_referenced_locally
  const STAGES = Array.from({ length: normal ? 5 : 3 }, (_, i) => String(i + 1));
  // svelte-ignore state_referenced_locally
  const TIMES = normal ? ['1', '2', '3'] : ['1', '2', '3', 'max'];

  let addRegion = $state('1');
  let addStage = $state('1');
  let addTimes = $state('1');
  let addStudent = $state('');

  function saveTokens(list: string[]): Promise<boolean> {
    return onSave(list.join(','));
  }

  async function addEntry(): Promise<void> {
    const token = `${addRegion}-${addStage}-${addTimes}`;
    if (tokens.includes(token)) return;
    if (await saveTokens([...tokens, token])) draft = [...tokens, token].join(',');
  }

  async function removeToken(i: number): Promise<void> {
    const next = tokens.filter((_, idx) => idx !== i);
    if (await saveTokens(next)) draft = next.join(',');
  }

  function scheduleText(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(commitText, 500);
  }

  async function commitText(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (draft === remote) return;
    const cleaned = draft
      .replace(/，/g, ',')
      .split(',')
      .map((x) => x.replace(/\s+/g, ''))
      .filter((x) => x !== '')
      .join(',');
    const ok = await onSave(cleaned);
    if (!ok) draft = remote; // 失败回退到远端值
  }

  async function addStudentStages(): Promise<void> {
    const entry = studentStages.find((s) => s.student === addStudent);
    addStudent = '';
    if (!entry || entry.stages.length === 0) return;
    const next = [...tokens];
    for (const stage of entry.stages) {
      if (!next.includes(stage)) next.push(stage);
    }
    if (await saveTokens(next)) draft = next.join(',');
  }

  function onBlurText(): void {
    focused = false;
    void commitText();
  }
</script>

<div class="wrap">
  <div class="chips">
    {#each tokens as token, i (token + i)}
      <span class="chip static">
        {token}
        <button class="op" type="button" title="移除" onclick={() => void removeToken(i)}>×</button>
      </span>
    {/each}
    {#if tokens.length === 0}
      <span class="dim">暂无扫荡设置</span>
    {/if}
  </div>

  <div class="add-row">
    <select class="input" bind:value={addRegion}>
      {#each REGIONS as r (r)}<option value={r}>{r}</option>{/each}
    </select>
    <span class="dim">-</span>
    <select class="input" bind:value={addStage}>
      {#each STAGES as s (s)}<option value={s}>{s}</option>{/each}
    </select>
    <span class="dim">-</span>
    <select class="input" bind:value={addTimes}>
      {#each TIMES as t (t)}<option value={t}>{t}</option>{/each}
    </select>
    <button class="btn" type="button" onclick={() => void addEntry()}>添加</button>
    {#if studentStages.length > 0}
      <select class="input" bind:value={addStudent} onchange={() => void addStudentStages()}>
        <option value="" disabled>按学生添加…</option>
        {#each studentStages as s (s.student)}
          <option value={s.student}>{s.student}</option>
        {/each}
      </select>
    {/if}
  </div>

  <input
    class="input text"
    placeholder="自由编辑，格式 关卡-次数，如 1-1-1,1-2-3"
    bind:value={draft}
    oninput={scheduleText}
    onfocus={() => (focused = true)}
    onblur={onBlurText}
  />
</div>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
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
    font-family: var(--mono);
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
  .add-row {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .add-row .input {
    width: auto;
    padding: 4px 8px;
  }
  .text {
    max-width: 420px;
  }
</style>
