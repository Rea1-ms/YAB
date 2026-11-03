<script lang="ts">
  import { getDirStores, setConfigValue } from '../stores';
  import { toast } from '../toast';
  import Switch from '../components/Switch.svelte';
  import TextField from '../components/TextField.svelte';

  let { dir }: { dir: string } = $props();
  // dir 由外层 {#key dir} 保证变化时重挂载，初始化读取即最终值
  // svelte-ignore state_referenced_locally
  const { args: argsStore } = getDirStores(dir);

  let filter = $state('');
  let jsonDrafts = $state<Record<string, string>>({});

  const entries = $derived(
    Object.entries($argsStore ?? {}).filter(([k]) =>
      k.toLowerCase().includes(filter.trim().toLowerCase()),
    ),
  );

  function kindOf(v: unknown): string {
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'number') return 'num';
    if (typeof v === 'string') return 'str';
    return 'json';
  }

  function jsonDraft(k: string, v: unknown): string {
    return jsonDrafts[k] ?? JSON.stringify(v ?? null, null, 2);
  }

  function onJsonInput(k: string, s: string): void {
    jsonDrafts = { ...jsonDrafts, [k]: s };
  }

  async function applyJson(k: string): Promise<void> {
    const raw = jsonDrafts[k];
    if (raw === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      toast('error', `${k}：JSON 解析失败`);
      return;
    }
    if (await setConfigValue(dir, k, parsed)) {
      const { [k]: _drop, ...rest } = jsonDrafts;
      jsonDrafts = rest;
    }
  }

  async function saveNum(k: string, raw: string): Promise<void> {
    const n = Number(raw);
    if (Number.isNaN(n)) {
      toast('error', `${k}：不是有效数字`);
      return;
    }
    await setConfigValue(dir, k, n);
  }

  async function saveBool(k: string, v: boolean): Promise<void> {
    await setConfigValue(dir, k, v);
  }

  async function saveStr(k: string, raw: string): Promise<void> {
    await setConfigValue(dir, k, raw);
  }
</script>

<div class="page">
  <div class="adv-hint">修改高级配置可能影响脚本运行</div>

  <div class="adv-tools">
    <input class="input" placeholder="按键名过滤…" bind:value={filter} />
    <span class="dim">{entries.length} / {Object.keys($argsStore ?? {}).length} 项</span>
  </div>

  <div class="card adv-list">
    {#each entries as [k, v] (k)}
      <div class="adv-row">
        <div class="k mono">
          {k}
          <span class="type">{kindOf(v)}</span>
        </div>
        <div class="v">
          {#if kindOf(v) === 'bool'}
            <Switch checked={v === true} onchange={(b) => saveBool(k, b)} />
          {:else if kindOf(v) === 'num'}
            <input
              class="input"
              type="number"
              value={Number(v)}
              onchange={(e) => saveNum(k, e.currentTarget.value)}
            />
          {:else if kindOf(v) === 'str'}
            <TextField value={v} onSave={(raw) => saveStr(k, raw)} />
          {:else}
            <div class="v-with-btn">
              <textarea
                class="input"
                rows="3"
                value={jsonDraft(k, v)}
                oninput={(e) => onJsonInput(k, e.currentTarget.value)}
              ></textarea>
              <button class="btn" type="button" onclick={() => applyJson(k)}>应用</button>
            </div>
          {/if}
        </div>
      </div>
    {/each}
    {#if entries.length === 0}
      <div class="empty dim">无匹配配置项</div>
    {/if}
  </div>
</div>

<style>
  .page {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    overflow: auto;
  }
  .adv-hint {
    color: var(--l2);
    font-size: 13px;
    background: rgba(224, 175, 104, 0.08);
    border: 1px solid rgba(224, 175, 104, 0.3);
    border-radius: 8px;
    padding: 8px 14px;
    flex: none;
  }
  .adv-tools {
    display: flex;
    gap: 12px;
    align-items: center;
    flex: none;
  }
  .adv-tools .input {
    width: 280px;
  }
  .adv-list {
    display: flex;
    flex-direction: column;
  }
  .adv-row {
    display: flex;
    gap: 16px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    align-items: flex-start;
  }
  .adv-row:last-child {
    border-bottom: none;
  }
  .adv-row .k {
    width: 260px;
    flex: none;
    font-size: 12.5px;
    padding-top: 6px;
    word-break: break-all;
  }
  .type {
    margin-left: 8px;
    color: var(--faint);
    font-size: 10px;
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 4px;
    font-family: var(--mono);
  }
  .adv-row .v {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .adv-row .v :global(.input) {
    max-width: 480px;
  }
  .v-with-btn {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    max-width: 580px;
  }
  .v-with-btn textarea {
    flex: 1;
  }
  .empty {
    text-align: center;
    padding: 24px;
  }
</style>
