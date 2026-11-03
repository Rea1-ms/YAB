<script lang="ts">
  import { callRpc } from '../../stores';
  import { toast } from '../../toast';
  import type { ActionItem } from '../../types';

  let {
    actions = [],
    dir,
  }: {
    actions: ActionItem[];
    dir: string;
  } = $props();

  async function run(task: string): Promise<void> {
    const r = await callRpc(`State:${dir}`, 'run_task', { task });
    if (r !== undefined) toast('success', `已提交任务：${task}`);
  }
</script>

<div class="actions">
  {#each actions as a (a.task)}
    <button class="btn" type="button" onclick={() => void run(a.task)}>{a.label}</button>
  {/each}
  {#if actions.length === 0}
    <span class="dim">暂无动作</span>
  {/if}
</div>

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
