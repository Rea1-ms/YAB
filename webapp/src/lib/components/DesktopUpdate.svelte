<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../i18n';
  import type { DesktopUpdateState } from '../desktop';

  let updateState = $state<DesktopUpdateState | null>(null);
  let requestError = $state('');
  let scheduleError = $state('');
  let savingSchedule = $state(false);
  let scheduleEnabled = $state(false);
  let scheduleTime = $state('08:00');
  const bridge = window.yabDesktop;
  const busy = $derived(!!updateState && ['checking', 'downloading', 'preparing', 'installing'].includes(updateState.phase));
  const status = $derived(updateState ? ({ idle: '尚未检查更新', checking: '正在检查更新…', current: '已是最新版本',
    available: '有新版本可用', downloading: '正在下载更新…', downloaded: '更新已下载',
    preparing: '正在停止任务并准备安装…', installing: '正在启动安装器…', error: '更新失败，可重试' })[updateState.phase] : '正在读取更新状态…');
  const variant = $derived(({ offline: '完整包', lite: '轻量包', 'lite-system': '系统工具轻量包' })[updateState?.variant ?? 'offline']);
  const error = $derived(requestError || updateState?.error || '');
  const message = $derived(requestError || (updateState && !updateState.enabled ? updateState.reason : error || status));

  function receive(next: DesktopUpdateState): void {
    if (!updateState || next.revision >= updateState.revision) {
      updateState = next;
      scheduleEnabled = next.schedule.enabled;
      scheduleTime = next.schedule.time;
    }
  }

  async function saveSchedule(schedule: DesktopUpdateState['schedule']): Promise<void> {
    if (savingSchedule || !updateState) return;
    scheduleError = '';
    savingSchedule = true;
    scheduleEnabled = schedule.enabled;
    scheduleTime = schedule.time;
    try {
      if (!bridge?.setUpdateSchedule) throw new Error('Unavailable');
      receive(await bridge.setUpdateSchedule(schedule));
    } catch {
      scheduleEnabled = updateState.schedule.enabled;
      scheduleTime = updateState.schedule.time;
      scheduleError = '更新检查设置保存失败，请重试';
    } finally { savingSchedule = false; }
  }

  async function run(action: 'checkUpdate' | 'downloadUpdate' | 'installUpdate', automatic = false): Promise<void> {
    requestError = '';
    try {
      const method = bridge?.[action];
      if (!method) { requestError = '桌面更新不可用'; return; }
      receive(action === 'checkUpdate' ? await bridge!.checkUpdate!(automatic ? { automatic: true } : undefined) : await method());
    } catch {
      requestError = ({ checkUpdate: '检查更新失败，请稍后重试', downloadUpdate: '下载更新失败，请稍后重试',
        installUpdate: '安装未完成，请重试' })[action];
    }
  }

  onMount(() => {
    let active = true;
    const unsubscribe = bridge?.onUpdateState?.(receive);
    void (async () => {
      try {
        const next = await bridge?.getUpdateState?.();
        if (!active) return;
        if (!next) { requestError = '桌面更新不可用'; return; }
        receive(next);
        if (next.enabled) await run('checkUpdate', true);
      } catch { if (active) requestError = '读取更新状态失败，请稍后重试'; }
    })();
    return () => { active = false; unsubscribe?.(); };
  });
</script>

<section class="card settings-card desktop-update" aria-busy={busy}>
  <h2>{$t('桌面更新')}</h2>
  <div class="versions">
    <span>{$t('当前版本：')}<b>{updateState?.currentVersion ?? '…'}</b></span>
    <span>{$t(variant)}</span>
    {#if updateState?.latestVersion}<span>{$t('新版本：')}<b>{updateState.latestVersion}</b></span>{/if}
  </div>
  <div class="actions">
    {#if updateState?.enabled}
      <button class="btn" disabled={busy || updateState.phase === 'downloaded'} onclick={() => void run('checkUpdate')}>{$t('检查更新')}</button>
    {/if}
    <span class="status" class:error={!!error} role="status" aria-live="polite">{$t(message)}</span>
    {#if updateState?.enabled}
      {#if updateState.phase === 'available' || (updateState.phase === 'error' && updateState.latestVersion)}
        <button class="btn primary" onclick={() => void run('downloadUpdate')}>{$t('下载更新')}</button>
      {/if}
      {#if updateState.phase === 'downloaded'}
        <button class="btn primary" onclick={() => void run('installUpdate')}>{$t('重启并更新')}</button>
      {/if}
    {/if}
  </div>
  {#if updateState?.lastResult}<p class="result">{$t(updateState.lastResult)}</p>{/if}
  {#if updateState?.enabled}
    <div class="schedule">
      <label class="schedule-toggle">
        <input type="checkbox" id="update-schedule-enabled" checked={scheduleEnabled} disabled={savingSchedule}
          onchange={(e) => void saveSchedule({ enabled: e.currentTarget.checked, time: scheduleTime })} />
        {$t('定时检查更新')}
      </label>
      {#if scheduleEnabled}
        <input class="input schedule-time" id="update-schedule-time" type="time" aria-label={$t('检查时间')}
          value={scheduleTime} disabled={savingSchedule}
          onchange={(e) => void saveSchedule({ enabled: true, time: e.currentTarget.value })} />
      {/if}
    </div>
    {#if scheduleError}<p class="schedule-error" role="alert">{$t(scheduleError)}</p>{/if}
    <p class="hint">{$t('安装前会停止所有任务，下载期间任务可以继续运行。')}</p>
  {/if}
  {#if updateState?.phase === 'downloading'}
    <progress max="100" value={updateState.percent} aria-label={$t('下载进度')}></progress>
    <p class="transfer">{updateState.percent.toFixed(1)}% · {(updateState.transferred / 1048576).toFixed(1)} / {(updateState.total / 1048576).toFixed(1)} {$t('兆字节')}</p>
  {/if}
  {#if updateState?.notes}<pre class="notes">{updateState.notes}</pre>{/if}
</section>

<style>
  .versions, .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
  .versions { font-size: 13px; color: var(--muted); }
  b { color: var(--text); margin-left: 5px; }
  .actions { margin-top: 12px; }
  .schedule, .schedule-toggle { display: flex; align-items: center; gap: 8px; }
  .schedule { margin-top: 12px; min-height: 34px; font-size: 13px; color: var(--muted); }
  .schedule-toggle { cursor: pointer; }
  .schedule-toggle input { margin: 0; accent-color: var(--accent); }
  .schedule-time { width: 112px; }
  .schedule-error { color: var(--danger); font-size: 12px; margin: 4px 0 0; }
  .status { min-height: 1.5em; overflow-wrap: anywhere; }
  .hint, .transfer { font-size: 12px; color: var(--muted); line-height: 1.6; }
  .error { color: var(--danger); white-space: pre-wrap; overflow-wrap: anywhere; }
  .notes { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; max-height: 260px; overflow: auto; }
  .result { color: var(--muted); }
  progress { width: 100%; accent-color: var(--accent); margin-top: 12px; }
</style>
