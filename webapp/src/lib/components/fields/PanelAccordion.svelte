<script lang="ts">
  /** 面板手风琴卡片：标题可展开收起，内部按组渲染字段 */
  import FieldControl from './FieldControl.svelte';
  import { t } from '../../i18n';
  import type { ConfigArgs, Panel } from '../../types';

  let {
    dir,
    panel,
    args,
    defaultOpen = false,
  }: {
    dir: string;
    panel: Panel;
    args: ConfigArgs;
    defaultOpen?: boolean;
  } = $props();

  // defaultOpen 仅取初始值（首个面板展开），后续由用户点击控制
  // svelte-ignore state_referenced_locally
  let open = $state(defaultOpen);
</script>

<div class="acc card">
  <button class="head" type="button" onclick={() => (open = !open)} aria-expanded={open}>
    <span class="arrow">{open ? '▾' : '▸'}</span>
    <span class="name">{$t(panel.name)}</span>
    {#if panel.tip}
      <span class="tip">{$t(panel.tip)}</span>
    {/if}
  </button>
  {#if open}
    <div class="body">
      {#each panel.groups as g, gi (gi)}
        <div class="group">
          {#if g.title}
            <div class="gtitle">{$t(g.title)}</div>
          {/if}
          {#each g.fields as f, fi (fi)}
            <div class="field">
              <div class="flabel">{$t(f.label)}</div>
              <div class="ctl">
                <FieldControl {dir} field={f} {args} />
                {#if f.help}
                  <div class="help">{$t(f.help)}</div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .acc {
    overflow: hidden;
  }
  .head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text);
    font-family: inherit;
    font-size: 14px;
    text-align: left;
  }
  .head:hover .name {
    color: var(--accent);
  }
  .arrow {
    color: var(--muted);
    font-size: 12px;
    flex: none;
    width: 14px;
  }
  .name {
    font-weight: 600;
    flex: none;
  }
  .tip {
    color: var(--faint);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .body {
    padding: 4px 16px 14px;
    border-top: 1px solid var(--border);
  }
  .group + .group {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px dashed var(--border);
  }
  .gtitle {
    color: var(--muted);
    font-size: 12.5px;
    margin: 6px 0 2px;
  }
  .field {
    display: flex;
    gap: 14px;
    padding: 7px 0;
    align-items: flex-start;
  }
  .flabel {
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
    max-width: 420px;
    width: 100%;
  }
  .help {
    color: var(--faint);
    font-size: 12px;
    line-height: 1.5;
  }
</style>
