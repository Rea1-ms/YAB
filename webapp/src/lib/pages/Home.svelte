<script lang="ts">
  import { callRpc, getDirStores } from '../stores';
  import { toast } from '../toast';
  import { t, tNow } from '../i18n';
  import AssetBar from '../components/AssetBar.svelte';

  let { dir }: { dir: string } = $props();
  // dir 由外层 {#key dir} 保证变化时重挂载，初始化读取即最终值
  // svelte-ignore state_referenced_locally
  const { log: logStore, state: stateStore } = getDirStores(dir);

  let taskInput = $state('');
  let logEl = $state<HTMLDivElement | null>(null);
  let stick = $state(true);

  const running = $derived($stateStore?.running ?? false);
  // State.button 为后端下发的中文（'启动'/'停止'），仅翻译显示
  const buttonLabel = $derived(
    $stateStore?.button ? $t($stateStore.button) : running ? $t('停止') : $t('启动'),
  );
  // current 为中文事件名或 '暂无任务'，仅翻译显示
  const currentTask = $derived($stateStore?.current ? $t($stateStore.current) : '—');
  const waiting = $derived($stateStore?.waiting ?? []);

  function toggleRun(): void {
    if (running) void callRpc(`State:${dir}`, 'stop', {});
    else void callRpc(`State:${dir}`, 'start', {});
  }

  async function runTask(): Promise<void> {
    const task = taskInput.trim();
    if (!task) {
      toast('info', tNow()('请输入任务名'));
      return;
    }
    const r = await callRpc(`State:${dir}`, 'run_task', { task });
    if (r !== undefined) {
      toast('success', tNow()('已提交任务：{0}').replace('{0}', () => tNow()(task)));
    }
  }

  function onScroll(): void {
    if (!logEl) return;
    stick = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
  }

  // 新日志到达时自动滚底（用户向上翻阅时暂停）
  $effect(() => {
    const count = $logStore.length;
    if (stick && count > 0 && logEl) logEl.scrollTop = logEl.scrollHeight;
  });

  function pad(n: number): string {
    return String(n).padStart(2, '0');
  }

  function fmtTime(t: number): string {
    const d = new Date(t * 1000);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function lvlClass(l: number): string {
    return `l${l >= 1 && l <= 4 ? l : 1}`;
  }
</script>

<div class="page">
  <AssetBar {dir} />
  <div class="card run-card">
    <button class="big-btn" class:running={running} type="button" onclick={toggleRun}>
      {buttonLabel}
    </button>
    <div class="run-meta">
      <div class="cur">{$t('当前任务：')}<b>{currentTask}</b></div>
      <div class="queue">
        {$t('等待队列：')}
        {#if waiting.length}
          {#each waiting as w (w)}
            <button class="chip" type="button" title={$t('点击填入运行任务')} onclick={() => (taskInput = w)}>
              {$t(w)}
            </button>
          {/each}
        {:else}
          <span class="dim">{$t('空')}</span>
        {/if}
      </div>
      <div class="task-run">
        <input
          class="input"
          placeholder={$t('输入任务名，单独运行一个任务')}
          bind:value={taskInput}
          onkeydown={(e) => e.key === 'Enter' && runTask()}
        />
        <button class="btn" type="button" onclick={runTask}>{$t('运行任务')}</button>
      </div>
    </div>
  </div>

  <div class="card log-card">
    <div class="log-head">{$t('运行日志')} <span class="dim">{$logStore.length} {$t('条')}</span></div>
    <div class="log-body" bind:this={logEl} onscroll={onScroll}>
      {#each $logStore as e, i (i)}
        <div class="log-line {lvlClass(e.l)}">
          <span class="lt">{fmtTime(e.t)}</span>
          <span class="lm">{e.m}</span>
        </div>
      {/each}
    </div>
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
    overflow: hidden;
  }
  .run-card {
    display: flex;
    align-items: center;
    gap: 28px;
    padding: 18px 22px;
    flex-wrap: wrap;
  }
  .big-btn {
    font-size: 20px;
    font-weight: 700;
    padding: 18px 72px;
    border-radius: 12px;
    background: var(--ok);
    border: 1px solid var(--ok);
    color: #0f1115;
    cursor: pointer;
    font-family: inherit;
    transition: filter 0.15s;
  }
  .big-btn:hover {
    filter: brightness(1.08);
  }
  .big-btn.running {
    background: var(--danger);
    border-color: var(--danger);
    color: #1a0d10;
  }
  .run-meta {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 260px;
    flex: 1;
  }
  .cur b {
    color: var(--accent);
  }
  .queue {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
    font-size: 13px;
  }
  .task-run {
    display: flex;
    gap: 8px;
  }
  .task-run .input {
    flex: 1;
  }
  .log-card {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .log-head {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 13px;
  }
  .log-body {
    flex: 1;
    overflow-y: auto;
    padding: 10px 14px;
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.65;
  }
  .log-line {
    display: flex;
    gap: 12px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .lt {
    color: var(--faint);
    flex: none;
  }
  .log-line.l1 .lm {
    color: var(--l1);
  }
  .log-line.l2 .lm {
    color: var(--l2);
  }
  .log-line.l3 .lm {
    color: var(--l3);
  }
  .log-line.l4 .lm {
    color: var(--l4);
  }
</style>
