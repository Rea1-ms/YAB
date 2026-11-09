<script lang="ts">
  import { callRpc, getDirStores, meta, setConfigValue } from '../stores';
  import { t, tNow } from '../i18n';
  import { toast } from '../toast';
  import Switch from './Switch.svelte';
  import type { PushChannel } from '../types';

  let { dir }: { dir: string } = $props();
  // svelte-ignore state_referenced_locally
  const { args: argsStore } = getDirStores(dir);
  let channels = $state<PushChannel[]>([]);
  let extraDrafts = $state<string[]>([]);
  let dirty = $state(false);
  let saving = $state(false);
  let testing = $state<number | null>(null);
  const providers = $derived($meta?.push_providers ?? []);
  const busy = $derived(saving || testing !== null);

  const labels: Record<string, string> = {
    device_key: '设备密钥', endpoint: '服务地址', token: '访问令牌',
    webhook: '机器人地址', pushkey: '推送密钥', key: '密钥或机器人地址',
    sckey: '推送密钥', sctkey: '推送密钥', host: '邮件服务器',
    user: '邮箱账号', password: '邮箱密码或授权码', userid: '接收会话编号',
    corpid: '企业编号', corpsecret: '应用密钥', agentid: '应用编号',
    url: '服务地址', topic: '订阅主题', apikey: '访问密钥',
  };

  function requiredKeys(provider: string): string[] {
    return providers.find((item) => item.id === provider)?.required ?? [];
  }

  $effect(() => {
    const saved = $argsStore?.push_onepush;
    if (!dirty && Array.isArray(saved) && providers.length) {
      channels = structuredClone(saved as PushChannel[]);
      extraDrafts = (saved as PushChannel[]).map((channel) => {
        const required = requiredKeys(channel.provider);
        const extra = Object.fromEntries(Object.entries(channel.params).filter(([key]) => !required.includes(key)));
        return Object.keys(extra).length ? JSON.stringify(extra, null, 2) : '{}';
      });
    }
  });

  function addChannel(): void {
    dirty = true;
    channels = [...channels, { provider: 'telegram', enabled: true, params: {}, proxy: '' }];
    extraDrafts = [...extraDrafts, '{}'];
  }

  function removeChannel(index: number): void {
    dirty = true;
    channels = channels.filter((_, position) => position !== index);
    extraDrafts = extraDrafts.filter((_, position) => position !== index);
  }

  function changeProvider(index: number, provider: string): void {
    dirty = true;
    channels[index] = { ...channels[index], provider, params: {} };
    extraDrafts[index] = '{}';
  }

  function buildChannel(index: number): PushChannel {
    let extra: unknown;
    try {
      extra = JSON.parse(extraDrafts[index] || '{}');
    } catch {
      throw new Error(tNow()('更多参数需要填写有效的 JSON 对象'));
    }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
      throw new Error(tNow()('更多参数需要填写有效的 JSON 对象'));
    }
    const channel = channels[index];
    const required = Object.fromEntries(requiredKeys(channel.provider).map((key) => [key, channel.params[key] ?? '']));
    return { ...channel, params: { ...extra, ...required } };
  }

  async function save(): Promise<void> {
    saving = true;
    try {
      const value = channels.map((_, index) => buildChannel(index));
      if (await setConfigValue(dir, 'push_onepush', value)) {
        dirty = false;
        toast('success', tNow()('推送设置已保存；正在运行的配置需停止后重新启动。'));
      }
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      saving = false;
    }
  }

  async function testChannel(index: number): Promise<void> {
    testing = index;
    try {
      const channel = { ...buildChannel(index), enabled: true };
      const result = await callRpc<{ success: boolean; message: string }>(`ConfigArg:${dir}`, 'push_test', { channel }, 60000);
      if (result) toast(result.success ? 'success' : 'error', tNow()(result.message));
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      testing = null;
    }
  }
</script>

<section class="card settings-card push-settings">
  <h2>{$t('推送通知')}</h2>
  <p class="hint">{$t('使用 OnePush，可同时配置多个渠道。旧推送配置会自动沿用。')}</p>
  {#each [['push_after_error', '出错时推送'], ['push_after_completion', '完成后推送']] as [key, label] (key)}
    <div class="field">
      <label for={key}>{$t(label)}</label>
      <div class="ctl"><Switch checked={Boolean($argsStore?.[key])} label={label} onchange={(value) => void setConfigValue(dir, key, value)} /></div>
    </div>
  {/each}

  {#each channels as channel, index (index)}
    <div class="push-channel">
      <div class="channel-head">
        <strong>{$t('推送渠道')} {index + 1}</strong>
        <Switch checked={channel.enabled} disabled={busy} label="启用渠道" onchange={(value) => { dirty = true; channels[index].enabled = value; }} />
        <button class="btn small" type="button" disabled={busy} onclick={() => removeChannel(index)}>{$t('移除渠道')}</button>
      </div>
      <div class="field">
        <label for={`push-provider-${index}`}>{$t('渠道类型')}</label>
        <div class="ctl">
          <select id={`push-provider-${index}`} class="input" value={channel.provider} disabled={busy} onchange={(event) => changeProvider(index, event.currentTarget.value)}>
            {#each providers as provider (provider.id)}
              <option value={provider.id}>{$t(provider.label)}</option>
            {/each}
          </select>
        </div>
      </div>
      {#each requiredKeys(channel.provider) as key (key)}
        <div class="field">
          <label for={`push-${index}-${key}`}>{$t(labels[key] ?? key)}</label>
          <div class="ctl">
            <input id={`push-${index}-${key}`} class="input" type={/token|key|password|secret|webhook/.test(key) ? 'password' : 'text'}
              autocomplete="off" disabled={busy} value={String(channel.params[key] ?? '')}
              oninput={(event) => { dirty = true; channels[index].params[key] = event.currentTarget.value; }} />
          </div>
        </div>
      {/each}
      {#if channel.provider !== 'smtp'}
        <div class="field">
          <label for={`push-proxy-${index}`}>{$t('代理地址')}</label>
          <div class="ctl">
            <input id={`push-proxy-${index}`} class="input" type="text" value={channel.proxy ?? ''} disabled={busy}
              placeholder="http://127.0.0.1:7890" oninput={(event) => { dirty = true; channels[index].proxy = event.currentTarget.value; }} />
            <span class="hint">{$t('留空使用系统网络设置。')}</span>
          </div>
        </div>
      {/if}
      <details>
        <summary>{$t('更多参数')}</summary>
        <p class="hint">{$t('以 JSON 对象填写可选参数，标题和正文由任务自动提供。')}</p>
        <p class="hint mono">{providers.find((provider) => provider.id === channel.provider)?.optional.join(', ')}</p>
        {#if channel.provider === 'telegram'}
          <p class="hint">{$t('自定义电报接口可填写 api_url，支持完整地址。')}</p>
        {:else if channel.provider === 'custom'}
          <p class="hint">{$t('自定义请求的 data 支持 {{title}} 和 {{content}} 占位符。')}</p>
        {/if}
        <textarea class="input extra-params" rows="4" aria-label={$t('更多参数')} disabled={busy} spellcheck="false"
          value={extraDrafts[index] ?? '{}'} oninput={(event) => { dirty = true; extraDrafts[index] = event.currentTarget.value; }}></textarea>
      </details>
      <button class="btn small" type="button" disabled={busy} onclick={() => testChannel(index)}>
        {testing === index ? $t('发送中…') : $t('发送测试通知')}
      </button>
    </div>
  {/each}
  {#if channels.length === 0}<p class="hint empty">{$t('尚未配置推送渠道')}</p>{/if}
  <div class="push-actions">
    <button class="btn" type="button" disabled={busy || channels.length >= 32 || !providers.length} onclick={addChannel}>{$t('添加渠道')}</button>
    <button class="btn primary" type="button" disabled={busy || !dirty} onclick={save}>{saving ? $t('保存中…') : $t('保存推送设置')}</button>
    {#if dirty}<span class="hint" role="status">{$t('有未保存的更改')}</span>{/if}
  </div>
</section>

<style>
  .push-channel { border-top: 1px solid var(--border); padding: 12px 0; min-width: 0; }
  .channel-head, .push-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
  .channel-head { margin-bottom: 8px; }
  .channel-head strong { margin-right: auto; font-size: 13px; }
  .small { padding: 5px 9px; font-size: 12px; }
  details { margin: 6px 0 12px; }
  summary { cursor: pointer; font-size: 12px; color: var(--muted); }
  details .hint { margin: 6px 0; }
  .extra-params { width: 100%; max-width: 100%; font-family: monospace; resize: vertical; }
  .empty { padding: 12px 0; }
</style>
