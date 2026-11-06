<script lang="ts">
  import { callRpc, connected } from '../stores';
  import { toast } from '../toast';
  import { t, tNow } from '../i18n';

  type Listener = { host: string; port: number };
  type WebSettings = { saved: Listener; active: Listener | null; port_override: boolean };
  let info = $state<WebSettings | null>(null);
  let host = $state('127.0.0.1');
  let port = $state('22267');
  let saving = $state(false);
  const pending = $derived(info?.active &&
    (info.saved.host !== info.active.host || info.saved.port !== info.active.port));

  $effect(() => {
    if (!$connected) return;
    let cancelled = false;
    void callRpc<WebSettings>('Meta', 'webui_get', {}).then((result) => {
      if (result && !cancelled) {
        info = result;
        host = result.saved.host;
        port = String(result.saved.port);
      }
    });
    return () => { cancelled = true; };
  });

  async function save(): Promise<void> {
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      toast('error', tNow()('端口需要填写 1 至 65535 的整数'));
      return;
    }
    saving = true;
    try {
      const result = await callRpc<WebSettings>('Meta', 'webui_save', { host: host.trim(), port: Number(port) });
      if (result) {
        info = result;
        host = result.saved.host;
        port = String(result.saved.port);
        toast('success', tNow()('网页服务设置已保存，重启应用后生效'));
      }
    } finally { saving = false; }
  }
</script>

<section class="card web-settings">
  <h2>{$t('网页访问')}</h2>
  <p class="hint">{$t('适用于所有配置，保存后重启应用生效。')}</p>
  <p class="current">{$t('当前访问地址：')}<a href={window.location.origin} target="_blank" rel="noreferrer">{window.location.origin}</a></p>
  {#if info?.active}
    <p class="hint">{$t('当前监听：')}{info.active.host}:{info.active.port}</p>
  {/if}
  <label for="web-listen-host">{$t('监听地址')}</label>
  <input id="web-listen-host" class="input" bind:value={host} placeholder="127.0.0.1" disabled={!info || saving} />
  <p class="hint">{$t('127.0.0.1 仅允许本机访问；0.0.0.0 允许局域网访问。')}</p>
  <p class="hint">{$t('局域网访问需要先通过 BAAS_WEBUI_TOKEN 环境变量设置访问密码。')}</p>
  <label for="web-listen-port">{$t('网页端口')}</label>
  <input id="web-listen-port" class="input" type="text" inputmode="numeric" bind:value={port} disabled={!info || saving} />
  {#if info?.port_override}
    <p class="notice">{$t('当前端口由 BAAS_DESKTOP_PORT 环境变量覆盖，移除后才使用此设置。')}</p>
  {:else if pending}
    <p class="notice">{$t('设置已更改，重启应用后生效。')}</p>
  {/if}
  <button class="btn" onclick={save} disabled={!$connected || !info || saving}>{$t('保存')}</button>
</section>

<style>
  .web-settings { padding: 18px; }
  h2 { margin: 0 0 12px; font-size: 16px; }
  label { display: block; margin: 12px 0 6px; font-size: 13px; color: var(--muted); }
  .input { width: 100%; max-width: 360px; }
  .hint { color: var(--faint); font-size: 12px; line-height: 1.6; margin: 5px 0; }
  .current { font-size: 13px; overflow-wrap: anywhere; }
  a { color: var(--accent); }
  .notice { font-size: 12px; color: var(--accent); line-height: 1.6; }
  .btn { margin-top: 14px; }
</style>
