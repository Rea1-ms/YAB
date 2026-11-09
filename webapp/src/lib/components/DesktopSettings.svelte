<script lang="ts">
  import { closeActions, type CloseAction } from '../desktop';
  import { t, tNow } from '../i18n';
  import { toast } from '../toast';

  const desktop = window.yabDesktop;
  let action = $state<CloseAction>('询问');
  let loaded = $state(false);
  let saving = $state(false);

  $effect(() => {
    if (!desktop?.getCloseAction) return;
    let cancelled = false;
    void desktop.getCloseAction().then(value => {
      if (!cancelled) { action = value; loaded = true; }
    }).catch(() => { if (!cancelled) toast('error', tNow()('无法读取桌面设置')); });
    return () => { cancelled = true; };
  });

  async function save(value: CloseAction): Promise<void> {
    if (!desktop?.setCloseAction) return;
    const previous = action;
    action = value;
    saving = true;
    try {
      action = await desktop.setCloseAction(value);
      toast('success', tNow()('桌面设置已保存'));
    } catch {
      action = previous;
      toast('error', tNow()('无法保存桌面设置'));
    } finally { saving = false; }
  }
</script>

{#if desktop?.getCloseAction}
  <section class="card settings-card desktop-settings">
    <h2>{$t('桌面应用')}</h2>
    <div class="field">
      <label for="desktop-close-action">{$t('关闭窗口时的操作')}</label>
      <div class="ctl">
        <select id="desktop-close-action" class="input" value={action} disabled={!loaded || saving}
          onchange={event => void save(event.currentTarget.value as CloseAction)}>
          {#each closeActions as option}
            <option value={option}>{$t(option)}</option>
          {/each}
        </select>
        <p class="hint">{$t('仅关闭窗口会隐藏到托盘；轻量模式会释放界面，后台任务继续运行。')}</p>
        <p class="hint">{$t('适用于当前桌面应用，保存后立即生效。')}</p>
      </div>
    </div>
  </section>
{/if}

<style>
  .desktop-settings { --settings-control-width: 200px; }
</style>
