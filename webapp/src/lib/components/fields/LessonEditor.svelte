<script lang="ts">
  let {
    regions = [],
    levels = [],
    levelLabels = [],
    times,
    priorities,
    onChange,
  }: {
    regions: string[];
    levels: string[];
    levelLabels: string[];
    times: unknown; // lesson_times 现值（int[]）
    priorities: unknown; // lesson_each_region_object_priority 现值（string[][]）
    onChange: (times: number[], priorities: string[][]) => void;
  } = $props();

  const timesList = $derived(
    Array.isArray(times) ? times.map((x) => Number(x) || 0) : ([] as number[]),
  );
  const priList = $derived(
    Array.isArray(priorities)
      ? priorities.map((r) => (Array.isArray(r) ? r.map(String) : []))
      : ([] as string[][]),
  );

  // 现值长度与区域数不符时，按默认全选初始化该行
  function effPri(i: number): string[] {
    if (priList.length === regions.length) return priList[i] ?? [];
    return [...levels];
  }

  function effTime(i: number): number {
    return timesList[i] ?? 0;
  }

  function allTimes(): number[] {
    return regions.map((_, idx) => timesList[idx] ?? 0);
  }

  function allPriorities(): string[][] {
    return regions.map((_, idx) => [...effPri(idx)]);
  }

  function toggleLevel(i: number, level: string): void {
    const cur = effPri(i);
    // 勾选集合保持 levels 的固定顺序
    const next = cur.includes(level)
      ? cur.filter((x) => x !== level)
      : levels.filter((l) => cur.includes(l) || l === level);
    const pri = allPriorities();
    pri[i] = next;
    onChange(allTimes(), pri);
  }

  function commitTime(i: number, raw: string): void {
    const n = raw.trim() === '' ? 0 : Math.max(0, Math.trunc(Number(raw) || 0));
    const next = allTimes();
    next[i] = n;
    onChange(next, allPriorities());
  }
</script>

<div class="wrap">
  <div class="head">
    <span class="hregion">区域</span>
    {#each levelLabels as lab, i (lab + i)}
      <span class="hlv">{lab}</span>
    {/each}
    <span class="htimes">次数</span>
  </div>
  {#each regions as region, i (region)}
    <div class="row">
      <span class="region" title={region}>{region}</span>
      {#each levels as level (level)}
        <span class="lv">
          <input
            type="checkbox"
            checked={effPri(i).includes(level)}
            onchange={() => toggleLevel(i, level)}
          />
        </span>
      {/each}
      <input
        class="input times"
        type="number"
        min="0"
        value={effTime(i)}
        onchange={(e) => commitTime(i, (e.currentTarget as HTMLInputElement).value)}
      />
    </div>
  {/each}
  {#if regions.length === 0}
    <span class="dim">暂无区域数据</span>
  {/if}
</div>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .head,
  .row {
    display: grid;
    grid-template-columns: minmax(110px, 170px) repeat(4, 52px) 76px;
    gap: 4px;
    align-items: center;
  }
  .head {
    color: var(--faint);
    font-size: 12px;
    padding-bottom: 2px;
  }
  .row {
    padding: 2px 0;
  }
  .region {
    font-size: 13px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lv {
    text-align: center;
  }
  .lv input {
    accent-color: var(--accent);
    cursor: pointer;
  }
  .htimes {
    text-align: center;
  }
  .times {
    width: 64px;
    padding: 3px 8px;
  }
</style>
