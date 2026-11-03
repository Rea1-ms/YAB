<script lang="ts">
  import { callRpc, getDirStores, meta, setEventEnabled } from '../stores';
  import { toast } from '../toast';
  import Switch from '../components/Switch.svelte';
  import type { EventItem, Hms } from '../types';

  let { dir }: { dir: string } = $props();
  // dir 由外层 {#key dir} 保证变化时重挂载，初始化读取即最终值
  // svelte-ignore state_referenced_locally
  const { events: eventStore } = getDirStores(dir);

  interface EventDraft {
    daily_reset: Hms[];
    disabled_time_range: [Hms, Hms][];
    pre_task: string[];
    post_task: string[];
  }

  let expanded = $state<string | null>(null);
  let drafts = $state<Record<string, EventDraft>>({});

  const draft = $derived(expanded ? drafts[expanded] : undefined);
  const eventNames = $derived($meta?.event_names ?? {});

  function makeDraft(it: EventItem): EventDraft {
    const hms = (t: unknown): Hms => {
      const a = Array.isArray(t) ? t : [];
      return [toInt(a[0]), toInt(a[1]), toInt(a[2])];
    };
    return {
      daily_reset: (it.daily_reset ?? []).map(hms),
      disabled_time_range: (it.disabled_time_range ?? []).map((r) => {
        const pair = Array.isArray(r) ? r : [];
        return [hms(pair[0]), hms(pair[1])];
      }),
      pre_task: [...(it.pre_task ?? [])],
      post_task: [...(it.post_task ?? [])],
    };
  }

  function toggleRow(fn: string, it: EventItem): void {
    if (expanded === fn) {
      expanded = null;
      return;
    }
    drafts[fn] = makeDraft(it);
    expanded = fn;
  }

  function toInt(x: unknown): number {
    const n = Math.floor(Number(x));
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }

  async function saveDraft(): Promise<void> {
    if (!expanded || !draft) return;
    const fn = expanded;
    const r = await callRpc(`EventConfig:${dir}`, 'set_event', {
      func_name: fn,
      patch: {
        daily_reset: draft.daily_reset.map((t) => [toInt(t[0]), toInt(t[1]), toInt(t[2])] as Hms),
        disabled_time_range: draft.disabled_time_range.map(
          (rg) =>
            [
              [toInt(rg[0][0]), toInt(rg[0][1]), toInt(rg[0][2])],
              [toInt(rg[1][0]), toInt(rg[1][1]), toInt(rg[1][2])],
            ] as [Hms, Hms],
        ),
        pre_task: [...draft.pre_task],
        post_task: [...draft.post_task],
      },
    });
    if (r !== undefined) {
      toast('success', `已保存「${fn}」`);
      expanded = null;
    }
  }

  function toggleIn(arr: string[], v: string, on: boolean): void {
    const i = arr.indexOf(v);
    if (on && i < 0) arr.push(v);
    if (!on && i >= 0) arr.splice(i, 1);
  }

  function enableAll(enabled: boolean): void {
    void callRpc(`EventConfig:${dir}`, 'enable_all', { enabled });
  }

  function refreshAll(): void {
    void callRpc(`EventConfig:${dir}`, 'refresh_all', {});
  }

  function pad(n: number): string {
    return String(n).padStart(2, '0');
  }

  function toLocalInput(epoch: number): string {
    if (!Number.isFinite(epoch) || epoch <= 0) return '';
    const d = new Date(epoch * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function saveNextTick(it: EventItem, value: string): Promise<void> {
    const t = new Date(value).getTime();
    if (Number.isNaN(t)) {
      toast('error', '时间格式无效');
      return;
    }
    await callRpc(`EventConfig:${dir}`, 'set_event', {
      func_name: it.func_name,
      patch: { next_tick: Math.floor(t / 1000) },
    });
  }
</script>

<div class="page">
  <div class="toolbar">
    <button class="btn" type="button" onclick={() => enableAll(true)}>全部启用</button>
    <button class="btn" type="button" onclick={() => enableAll(false)}>全部禁用</button>
    <button class="btn" type="button" onclick={refreshAll}>刷新执行时间</button>
    <span class="dim">共 {$eventStore?.length ?? 0} 个事件</span>
  </div>

  <div class="card table-wrap">
    <table class="table">
      <thead>
        <tr>
          <th>启用</th>
          <th>事件名</th>
          <th>函数</th>
          <th>下次执行</th>
          <th>优先级</th>
          <th>间隔（秒）</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each $eventStore ?? [] as it (it.func_name)}
          <tr>
            <td><Switch checked={it.enabled} onchange={(v) => setEventEnabled(dir, it.func_name, v)} /></td>
            <td>{it.event_name || it.func_name}</td>
            <td class="mono fn">{it.func_name}</td>
            <td>
              <input
                class="input dt"
                type="datetime-local"
                value={toLocalInput(it.next_tick)}
                onchange={(e) => saveNextTick(it, e.currentTarget.value)}
              />
            </td>
            <td>{it.priority}</td>
            <td>{it.interval}</td>
            <td>
              <button class="mini" type="button" onclick={() => toggleRow(it.func_name, it)}>
                {expanded === it.func_name ? '收起' : '展开编辑'}
              </button>
            </td>
          </tr>
          {#if expanded === it.func_name && draft}
            <tr>
              <td colspan="7" class="editor-cell">
                <div class="editor">
                  <div>
                    <div class="sec-title">每日重置 daily_reset（时 / 分 / 秒）</div>
                    {#each draft.daily_reset as tm, i (i)}
                      <div class="hms-row">
                        <input class="input" type="number" min="0" max="23" value={tm[0]} oninput={(e) => (tm[0] = toInt(e.currentTarget.value))} /> 时
                        <input class="input" type="number" min="0" max="59" value={tm[1]} oninput={(e) => (tm[1] = toInt(e.currentTarget.value))} /> 分
                        <input class="input" type="number" min="0" max="59" value={tm[2]} oninput={(e) => (tm[2] = toInt(e.currentTarget.value))} /> 秒
                        <button class="mini" type="button" onclick={() => draft.daily_reset.splice(i, 1)}>删除</button>
                      </div>
                    {/each}
                    <button class="mini" type="button" onclick={() => draft.daily_reset.push([0, 0, 0])}>
                      添加时间点
                    </button>
                  </div>

                  <div>
                    <div class="sec-title">禁用时段 disabled_time_range（开始 — 结束，时 / 分 / 秒）</div>
                    {#each draft.disabled_time_range as rg, i (i)}
                      <div class="range-row">
                        <input class="input" type="number" min="0" max="23" value={rg[0][0]} oninput={(e) => (rg[0][0] = toInt(e.currentTarget.value))} /> 时
                        <input class="input" type="number" min="0" max="59" value={rg[0][1]} oninput={(e) => (rg[0][1] = toInt(e.currentTarget.value))} /> 分
                        <input class="input" type="number" min="0" max="59" value={rg[0][2]} oninput={(e) => (rg[0][2] = toInt(e.currentTarget.value))} /> 秒
                        <span class="dim">—</span>
                        <input class="input" type="number" min="0" max="23" value={rg[1][0]} oninput={(e) => (rg[1][0] = toInt(e.currentTarget.value))} /> 时
                        <input class="input" type="number" min="0" max="59" value={rg[1][1]} oninput={(e) => (rg[1][1] = toInt(e.currentTarget.value))} /> 分
                        <input class="input" type="number" min="0" max="59" value={rg[1][2]} oninput={(e) => (rg[1][2] = toInt(e.currentTarget.value))} /> 秒
                        <button class="mini" type="button" onclick={() => draft.disabled_time_range.splice(i, 1)}>删除</button>
                      </div>
                    {/each}
                    <button class="mini" type="button" onclick={() => draft.disabled_time_range.push([[0, 0, 0], [0, 0, 0]])}>
                      添加时段
                    </button>
                  </div>

                  <div class="task-cols">
                    <div class="task-col">
                      <div class="sec-title">前置任务 pre_task</div>
                      {#each Object.entries(eventNames) as [fn, name] (fn)}
                        <label class="check">
                          <input
                            type="checkbox"
                            checked={draft.pre_task.includes(fn)}
                            onchange={(e) => toggleIn(draft.pre_task, fn, e.currentTarget.checked)}
                          />
                          {name || fn} <span class="mono fnname">{fn}</span>
                        </label>
                      {/each}
                    </div>
                    <div class="task-col">
                      <div class="sec-title">后续任务 post_task</div>
                      {#each Object.entries(eventNames) as [fn, name] (fn)}
                        <label class="check">
                          <input
                            type="checkbox"
                            checked={draft.post_task.includes(fn)}
                            onchange={(e) => toggleIn(draft.post_task, fn, e.currentTarget.checked)}
                          />
                          {name || fn} <span class="mono fnname">{fn}</span>
                        </label>
                      {/each}
                    </div>
                  </div>

                  <div class="editor-foot">
                    <button class="btn primary" type="button" onclick={saveDraft}>保存</button>
                    <button class="btn" type="button" onclick={() => (expanded = null)}>取消</button>
                  </div>
                </div>
              </td>
            </tr>
          {/if}
        {/each}
        {#if !$eventStore?.length}
          <tr>
            <td colspan="7" class="dim empty">暂无事件数据</td>
          </tr>
        {/if}
      </tbody>
    </table>
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
  .toolbar {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .table-wrap {
    overflow: auto;
  }
  .fn {
    color: var(--muted);
    font-size: 12px;
  }
  .dt {
    width: 210px;
  }
  .editor-cell {
    background: var(--panel2);
  }
  .editor {
    padding: 6px 4px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .sec-title {
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 8px;
  }
  .hms-row,
  .range-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--muted);
  }
  .hms-row .input,
  .range-row .input {
    width: 68px;
    padding: 4px 6px;
  }
  .task-cols {
    display: flex;
    gap: 40px;
    flex-wrap: wrap;
  }
  .task-col {
    max-height: 220px;
    overflow: auto;
    min-width: 280px;
  }
  .check {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 2px 0;
    cursor: pointer;
    font-size: 13px;
  }
  .fnname {
    color: var(--faint);
    font-size: 11px;
  }
  .editor-foot {
    display: flex;
    gap: 10px;
  }
  .empty {
    text-align: center;
    padding: 20px;
  }
</style>
