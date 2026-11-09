<script lang="ts">
  import { callRpc, getDirStores, meta, setConfigValue } from '../stores';
  import { toast } from '../toast';
  import { t, tNow } from '../i18n';
  import Switch from '../components/Switch.svelte';
  import TextField from '../components/TextField.svelte';
  import PanelAccordion from '../components/fields/PanelAccordion.svelte';
  import WebServerSettings from '../components/WebServerSettings.svelte';
  import DesktopSettings from '../components/DesktopSettings.svelte';
  import PushSettings from '../components/PushSettings.svelte';
  import type { Meta } from '../types';

  let { dir }: { dir: string } = $props();
  // dir 由外层 {#key dir} 保证变化时重挂载，初始化读取即最终值
  // svelte-ignore state_referenced_locally
  const { args: argsStore, panels: panelsStore } = getDirStores(dir);

  type OptKey = 'then_options' | 'screenshot_methods' | 'control_methods' | 'servers' | 'multi_emulator_names';

  interface FieldDef {
    key: string;
    label: string;
    kind: 'text' | 'switch' | 'select';
    optKey?: OptKey;
    hint?: string;
    placeholder?: string;
  }

  interface Section {
    title: string;
    fields: FieldDef[];
    adb?: boolean;
    hint?: string;
  }

  const SECTIONS: Section[] = [
    {
      title: '脚本相关',
      fields: [
        { key: 'screenshot_interval', label: '截图间隔', kind: 'text', hint: '请填写您的截图间隔' },
        { key: 'autostart', label: '启动Baas后直接运行', kind: 'switch' },
        { key: 'then', label: '完成后', kind: 'select', optKey: 'then_options' },
        {
          key: 'screenshot_method',
          label: '截图方式',
          kind: 'select',
          optKey: 'screenshot_methods',
          hint: '通用安卓设备可先用 adb（通用截图）或 scrcpy（投屏截图）；nemu（MuMu 专用截图）仅适用于对应的本机模拟器。',
        },
        {
          key: 'control_method',
          label: '控制方式',
          kind: 'select',
          optKey: 'control_methods',
          hint: '通用安卓设备可先用 adb（通用触控）；maatouch（触控服务）需要设备支持。',
        },
      ],
    },
    {
      title: '游戏服务器与设备',
      adb: true,
      hint: '游戏服务器决定使用哪个版本的游戏，与设备类型无关。可以连接真机、模拟器或 redroid（容器安卓设备）。',
      fields: [
        { key: 'server', label: '游戏服务器', kind: 'select', optKey: 'servers' },
        { key: 'adbIP', label: '设备地址或序列号', kind: 'text', hint: '网络设备填写地址；已连接的真机也可以填写序列号，并将端口留空。' },
        { key: 'adbPort', label: '设备端口', kind: 'text', placeholder: '通常为 5555，以设备实际配置为准' },
      ],
    },
    {
      title: '模拟器启动设置',
      hint: '这部分只用于自动打开本机模拟器。使用真机或 redroid（容器安卓设备）时保持关闭，无需填写模拟器路径。',
      fields: [
        { key: 'open_emulator_stat', label: '启动Baas时打开模拟器', kind: 'switch' },
        { key: 'emulator_wait_time', label: '等待时间（秒）', kind: 'text' },
        { key: 'emulatorIsMultiInstance', label: '模拟器多开', kind: 'switch' },
        {
          key: 'program_address',
          label: '模拟器路径',
          kind: 'text',
          placeholder: '例如 D:\\MuMu\\shell\\MuMuPlayer.exe',
        },
        { key: 'multiEmulatorName', label: '多开模拟器类型', kind: 'select', optKey: 'multi_emulator_names' },
        { key: 'emulatorMultiInstanceNumber', label: '多开编号', kind: 'text' },
      ],
    },
  ];

  function save(key: string, value: unknown): void {
    void setConfigValue(dir, key, value);
  }

  /** 拉取下拉选项：multi_emulator_names 用中文显示名，其余原样 */
  function optEntries(f: FieldDef, m: Meta | null): [string, string][] {
    if (!f.optKey || !m) return [];
    if (f.optKey === 'multi_emulator_names') return Object.entries(m.multi_emulator_names ?? {});
    return (m[f.optKey] ?? []).map((o) => [o, o] as [string, string]);
  }

  // —— adb 地址检测 ——
  let searching = $state(false);
  let connecting = $state(false);
  let adbResults: string[] | null = $state(null);

  async function searchAdb(): Promise<void> {
    searching = true;
    try {
      const r = await callRpc<unknown>('Meta', 'autosearch_adb', {});
      if (r !== undefined) {
        const list = Array.isArray(r) ? r : r == null ? [] : [r];
        adbResults = list.map((x) => String(x));
        if (adbResults.length === 0) {
          toast('info', tNow()('暂未发现已连接设备。网络设备可以填写地址和端口后，点击“连接设备”。'));
        }
      }
    } finally {
      searching = false;
    }
  }

  async function pickAdb(addr: string): Promise<void> {
    const match = addr.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
    const host = match ? match[1] ?? match[2] : addr;
    const port = match?.[3] ?? '';
    if (!await setConfigValue(dir, 'adbIP', host)) return;
    if (!await setConfigValue(dir, 'adbPort', port)) return;
    toast('success', tNow()('已选择设备：{0}').replace('{0}', () => addr));
    adbResults = null;
  }

  async function connectAdb(): Promise<void> {
    connecting = true;
    try {
      const result = await callRpc<{ serial: string }>('Meta', 'connect_adb', {
        host: String($argsStore?.adbIP ?? ''),
        port: String($argsStore?.adbPort ?? ''),
      });
      if (result) {
        toast('success', tNow()('设备已连接：{0}').replace('{0}', () => result.serial));
        await searchAdb();
      }
    } finally {
      connecting = false;
    }
  }

  // 结构化设置面板（page == 'settings'）
  const settingsPanels = $derived(($panelsStore?.panels ?? []).filter((p) => p.page === 'settings'));
</script>

<div class="page">
  <div class="cards">
    <WebServerSettings />
    <DesktopSettings />
    {#each SECTIONS as sec (sec.title)}
      <div class="card sec settings-card">
        <h2>{$t(sec.title)}</h2>
        {#if sec.hint}
          <p class="hint">{$t(sec.hint)}</p>
        {/if}
        {#each sec.fields as f (f.key)}
          <div class="field">
            <label for={f.key}>{$t(f.label)}</label>
            <div class="ctl">
              {#if f.kind === 'switch'}
                <Switch checked={Boolean($argsStore?.[f.key])} onchange={(v) => save(f.key, v)} />
              {:else if f.kind === 'select'}
                <select
                  id={f.key}
                  class="input"
                  value={String($argsStore?.[f.key] ?? '')}
                  onchange={(e) => save(f.key, (e.currentTarget as HTMLSelectElement).value)}
                >
                  <option value="" disabled>{$t('请选择')}</option>
                  {#each optEntries(f, $meta) as [v, label] (v)}
                    <option value={v}>{$t(label)}</option>
                  {/each}
                </select>
              {:else}
                <TextField value={$argsStore?.[f.key]} onSave={(raw) => save(f.key, raw)} placeholder={f.placeholder ? $t(f.placeholder) : undefined} />
              {/if}
              {#if f.hint}
                <div class="hint">{$t(f.hint)}</div>
              {/if}
            </div>
          </div>
        {/each}
        {#if sec.adb}
          <div class="adb-tools">
            <button class="btn" type="button" disabled={connecting || searching} onclick={connectAdb}>
              {connecting ? $t('连接中…') : $t('连接设备')}
            </button>
            <button class="btn" type="button" disabled={searching || connecting} onclick={searchAdb}>
              {searching ? $t('刷新中…') : $t('刷新设备列表')}
            </button>
            {#if adbResults}
              {#each adbResults as addr (addr)}
                <button class="chip" type="button" title={$t('点击选择设备')} onclick={() => pickAdb(addr)}>
                  {addr}
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    {/each}
    <PushSettings {dir} />
  </div>

  {#if settingsPanels.length > 0}
    <div class="panel-section">
      <h2 class="panel-head">{$t('任务与功能设置')}</h2>
      <div class="panel-list">
        {#each settingsPanels as p (p.id)}
          <PanelAccordion {dir} panel={p} args={$argsStore ?? {}} />
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .page {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: 16px;
    overflow: auto;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(430px, 1fr));
    gap: 12px;
    align-items: start;
  }
  .adb-tools {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 6px;
  }
  .panel-section {
    margin-top: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .panel-head {
    margin: 0;
    font-size: 15px;
    color: var(--accent);
    font-weight: 600;
  }
  .panel-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
</style>
