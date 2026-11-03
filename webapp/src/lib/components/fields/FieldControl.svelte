<script lang="ts">
  /** 面板字段渲染分发器：按 field.type 选择对应控件并处理保存 */
  import { setConfigValue, setSweep } from '../../stores';
  import type { ConfigArgs, OptionItem, PanelField, ShopRow } from '../../types';
  import Switch from '../Switch.svelte';
  import TextField from '../TextField.svelte';
  import Checklist from './Checklist.svelte';
  import ShopChecklist from './ShopChecklist.svelte';
  import OrderedChecklist from './OrderedChecklist.svelte';
  import StudentText from './StudentText.svelte';
  import SlotsSelect from './SlotsSelect.svelte';
  import TagList from './TagList.svelte';
  import LessonEditor from './LessonEditor.svelte';
  import SweepEditor from './SweepEditor.svelte';
  import ActionsField from './ActionsField.svelte';
  import NumberField from './NumberField.svelte';
  import {
    isShopRow,
    saveFieldValue,
    saveNumberValue,
    saveSelectValue,
    toOptionPairs,
    toPlainStrings,
  } from './shared';

  let { dir, field, args }: { dir: string; field: PanelField; args: ConfigArgs } = $props();

  // __ 开头的字段（actions）无配置键
  const value = $derived(
    field.key && !field.key.startsWith('__') ? args[field.key] : undefined,
  );

  const shopRows = $derived<ShopRow[]>((field.options ?? []).filter(isShopRow));

  /** lesson_editor：同时保存 lesson_times 与 lesson_each_region_object_priority */
  async function saveLesson(times: number[], priorities: string[][]): Promise<void> {
    if (!field.key) return;
    await setConfigValue(dir, field.key, times);
    await setConfigValue(dir, 'lesson_each_region_object_priority', priorities);
  }

  /** sweep_editor：保存走 set_sweep RPC */
  function saveSweep(raw: string): Promise<boolean> {
    return setSweep(dir, field.sweep_key ?? field.key ?? '', raw);
  }
</script>

{#if field.type === 'switch'}
  <Switch checked={value === true} onchange={(v) => void saveFieldValue(dir, field, v)} />
{:else if field.type === 'text'}
  <TextField {value} onSave={(raw) => void saveFieldValue(dir, field, raw)} />
{:else if field.type === 'number'}
  <NumberField {value} max={field.max} onSave={(raw) => void saveNumberValue(dir, field, raw, value)} />
{:else if field.type === 'select'}
  <select
    class="input"
    value={value == null ? '' : String(value)}
    onchange={(e) => void saveSelectValue(dir, field, (e.currentTarget as HTMLSelectElement).value)}
  >
    <option value="" disabled>请选择</option>
    {#each toOptionPairs(field.options as OptionItem[] | undefined) as [v, label] (v)}
      <option value={v}>{label}</option>
    {/each}
  </select>
{:else if field.type === 'checklist'}
  <Checklist options={toPlainStrings(field.options)} {value} onchange={(v) => void saveFieldValue(dir, field, v)} />
{:else if field.type === 'shop_checklist'}
  <ShopChecklist rows={shopRows} {value} onchange={(v) => void saveFieldValue(dir, field, v)} />
{:else if field.type === 'ordered_checklist'}
  <OrderedChecklist options={toPlainStrings(field.options)} {value} onchange={(v) => void saveFieldValue(dir, field, v)} />
{:else if field.type === 'student_text'}
  <StudentText options={toPlainStrings(field.options)} {value} onchange={(v) => void saveFieldValue(dir, field, v)} />
{:else if field.type === 'slots_select'}
  <SlotsSelect
    options={toPlainStrings(field.options)}
    {value}
    coerce={field.coerce}
    onchange={(v) => void saveFieldValue(dir, field, v)}
  />
{:else if field.type === 'tag_list'}
  <TagList {value} onchange={(v) => void saveFieldValue(dir, field, v)} />
{:else if field.type === 'lesson_editor'}
  <LessonEditor
    regions={toPlainStrings(field.options)}
    levels={field.levels ?? []}
    levelLabels={field.level_labels ?? field.levels ?? []}
    times={field.key ? args[field.key] : undefined}
    priorities={args['lesson_each_region_object_priority']}
    onChange={(t, p) => void saveLesson(t, p)}
  />
{:else if field.type === 'sweep_editor'}
  <SweepEditor
    {value}
    normal={field.normal !== false}
    studentStages={field.student_stages ?? []}
    onSave={saveSweep}
  />
{:else if field.type === 'actions'}
  <ActionsField actions={field.actions ?? []} {dir} />
{:else}
  <span class="dim">未知字段类型：{field.type}</span>
{/if}
