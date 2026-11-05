<script lang="ts">
  /** 主页资产条：挂载时每 2s 轮询 Assets:<dir>.get（卸载自动停止） */
  import { getDirStores } from '../stores';
  import { ws } from '../ws';
  import { t } from '../i18n';
  import type { AssetCount, AssetsData } from '../types';

  let { dir }: { dir: string } = $props();
  // dir 由外层 {#key dir} 保证变化时重挂载；复用目录 store 读取 server 判断 JP
  // svelte-ignore state_referenced_locally
  const { args } = getDirStores(dir);

  let data = $state<AssetsData | null>(null);
  let now = $state(Math.floor(Date.now() / 1000));

  async function refresh(): Promise<void> {
    try {
      data = await ws.rpc<AssetsData>(`Assets:${dir}`, 'get', {});
    } catch {
      // 断线时静默保留上次数据，重连后下轮恢复
    }
  }

  $effect(() => {
    void refresh();
    const timer = setInterval(() => {
      now = Math.floor(Date.now() / 1000);
      void refresh();
    }, 2000);
    return () => clearInterval(timer);
  });

  // 日服配置额外显示 _pass（Meta 无 server 信息，读 config.server）
  const isJp = $derived(String($args?.server ?? '').includes('日服'));

  function countOf(a: AssetCount | null | undefined): number | null {
    const c = a?.count;
    return typeof c === 'number' && Number.isFinite(c) ? c : null;
  }

  function countText(a: AssetCount | null | undefined): string {
    const c = countOf(a);
    return c === null || c <= 0 ? $t('未知') : String(c);
  }

  function maxText(a: AssetCount | null | undefined): string {
    const m = a?.max;
    return typeof m === 'number' && m > 0 ? String(m) : $t('未知');
  }

  const apText = $derived((countOf(data?.ap) ?? -1) <= 0 ? $t('未知') : `${countText(data?.ap)}/${maxText(data?.ap)}`);

  function timeText(a: AssetCount | null | undefined): string {
    const t0 = a?.time;
    if (typeof t0 !== 'number' || t0 <= 0) return '-';
    const mins = Math.max(0, Math.floor((now - t0) / 60));
    return $t('{0}分钟前').replace('{0}', () => String(mins));
  }

  function keystoneText(v: number | null | undefined): string {
    return typeof v === 'number' && v > 0 ? String(v) : $t('未知');
  }

  const passLevel = $derived(data?._pass?.level);

  interface Cell {
    label: string;
    value: string;
    time?: string;
    title?: string;
  }

  const cells = $derived.by<Cell[]>(() => {
    const d = data;
    const list: Cell[] = [
      { label: $t('体力'), value: apText, time: timeText(d?.ap) },
      { label: $t('信用点'), value: countText(d?.creditpoints), time: timeText(d?.creditpoints) },
      { label: $t('青辉石'), value: countText(d?.pyroxene), time: timeText(d?.pyroxene) },
      { label: $t('竞技币'), value: countText(d?.tactical_challenge_coin), time: timeText(d?.tactical_challenge_coin) },
      { label: $t('悬赏币'), value: countText(d?.bounty_coin), time: timeText(d?.bounty_coin) },
      { label: $t('制造石'), value: keystoneText(d?.Keystone), title: 'Keystone' },
      { label: $t('制造石碎片'), value: keystoneText(d?.['Keystone-Piece']), title: 'Keystone-Piece' },
    ];
    if (isJp) {
      list.push({
        label: 'Pass',
        value: typeof passLevel === 'number' && passLevel > 0 ? `Lv.${passLevel}` : $t('未知'),
      });
    }
    return list;
  });
</script>

<div class="bar card">
  {#each cells as c (c.label)}
    <div class="cell" title={c.title}>
      <span class="lab">{c.label}</span>
      <span class="val">{c.value}</span>
      {#if c.time}
        <span class="time">{c.time}</span>
      {/if}
    </div>
  {/each}
</div>

<style>
  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 26px;
    padding: 10px 18px;
    align-items: center;
    flex: none;
  }
  .cell {
    display: flex;
    align-items: baseline;
    gap: 7px;
    min-width: 0;
  }
  .lab {
    color: var(--muted);
    font-size: 12px;
    flex: none;
  }
  .val {
    color: var(--accent);
    font-family: var(--mono);
    font-size: 13.5px;
    font-weight: 600;
  }
  .time {
    color: var(--faint);
    font-size: 11px;
  }
</style>
