<script lang="ts">
  import { callRpc, getDirStores, meta, setConfigValue } from '../stores';
  import { toast } from '../toast';
  import Switch from '../components/Switch.svelte';
  import TextField from '../components/TextField.svelte';
  import type { Meta } from '../types';

  let { dir }: { dir: string } = $props();
  // dir 由外层 {#key dir} 保证变化时重挂载，初始化读取即最终值
  // svelte-ignore state_referenced_locally
  const { args: argsStore } = getDirStores(dir);

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
          hint: "速度 nemu >> uiautomator2 ≈ adb ≈ adb_nc，推荐使用nemu；如果使用nemu, 请在'模拟器启动设置'里设置模拟器路径",
        },
        {
          key: 'control_method',
          label: '控制方式',
          kind: 'select',
          optKey: 'control_methods',
          hint: 'uiautomator2 兼容性最好；maatouch 速度更快',
        },
      ],
    },
    {
      title: '服务器',
      adb: true,
      fields: [
        { key: 'server', label: '服务器', kind: 'select', optKey: 'servers' },
        { key: 'adbIP', label: 'ADB IP', kind: 'text' },
        { key: 'adbPort', label: 'ADB 端口', kind: 'text' },
      ],
    },
    {
      title: '模拟器启动设置',
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
    {
      title: '推送通知',
      fields: [
        { key: 'push_after_error', label: '出错时推送', kind: 'switch' },
        { key: 'push_after_completion', label: '完成后推送', kind: 'switch' },
        { key: 'push_serverchan', label: 'Server酱 SendKey', kind: 'text' },
        { key: 'push_feishu', label: '飞书 Webhook', kind: 'text' },
        { key: 'push_wecom', label: '企业微信 Webhook', kind: 'text' },
        { key: 'push_telegram_bot_token', label: 'Telegram Bot Token', kind: 'text' },
        { key: 'push_telegram_chat_id', label: 'Telegram Chat ID', kind: 'text' },
        { key: 'push_telegram_api', label: 'Telegram API', kind: 'text' },
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
  let adbResults: string[] | null = $state(null);

  async function searchAdb(): Promise<void> {
    searching = true;
    try {
      const r = await callRpc<unknown>('Meta', 'autosearch_adb', {});
      if (r !== undefined) {
        const list = Array.isArray(r) ? r : r == null ? [] : [r];
        adbResults = list.map((x) => String(x));
        if (adbResults.length === 0) toast('info', '未检测到正在运行的模拟器');
      }
    } finally {
      searching = false;
    }
  }

  async function pickAdb(addr: string): Promise<void> {
    const [ip, port] = addr.split(':');
    await setConfigValue(dir, 'adbIP', ip ?? '');
    await setConfigValue(dir, 'adbPort', port ?? '5555');
    toast('success', `已写入 adb 地址：${addr}`);
    adbResults = null;
  }
</script>

<div class="page">
  <div class="cards">
    {#each SECTIONS as sec (sec.title)}
      <div class="card sec">
        <h2>{sec.title}</h2>
        {#each sec.fields as f (f.key)}
          <div class="field">
            <label for={f.key}>{f.label}</label>
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
                  <option value="" disabled>请选择</option>
                  {#each optEntries(f, $meta) as [v, label] (v)}
                    <option value={v}>{label}</option>
                  {/each}
                </select>
              {:else}
                <TextField value={$argsStore?.[f.key]} onSave={(raw) => save(f.key, raw)} placeholder={f.placeholder} />
              {/if}
              {#if f.hint}
                <div class="hint">{f.hint}</div>
              {/if}
            </div>
          </div>
        {/each}
        {#if sec.adb}
          <div class="adb-tools">
            <button class="btn" type="button" disabled={searching} onclick={searchAdb}>
              {searching ? '搜索中…' : '检测adb地址'}
            </button>
            {#if adbResults}
              {#each adbResults as addr (addr)}
                <button class="chip" type="button" title="点击写入 adbIP / adbPort" onclick={() => pickAdb(addr)}>
                  {addr}
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
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
  .sec {
    padding: 16px 18px;
  }
  .sec h2 {
    margin: 0 0 12px;
    font-size: 15px;
    color: var(--accent);
    font-weight: 600;
  }
  .field {
    display: flex;
    gap: 14px;
    padding: 7px 0;
    align-items: flex-start;
  }
  .field label {
    width: 150px;
    flex: none;
    color: var(--muted);
    font-size: 13px;
    padding-top: 6px;
    text-align: right;
  }
  .ctl {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ctl :global(.input) {
    max-width: 360px;
    width: 100%;
  }
  .hint {
    color: var(--faint);
    font-size: 12px;
    line-height: 1.5;
  }
  .adb-tools {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 6px;
  }
</style>
