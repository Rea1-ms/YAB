<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../i18n';

  let {
    open = $bindable(false),
    title = '',
    confirmText = '确定',
    danger = false,
    onconfirm,
    children,
  }: {
    open?: boolean;
    title?: string;
    /** 确认按钮文案（中文原文，显示时经 $t 翻译） */
    confirmText?: string;
    danger?: boolean;
    onconfirm: () => unknown;
    children?: Snippet;
  } = $props();

  function onOverlayKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') open = false;
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && open && (open = false)} />

{#if open}
  <div
    class="overlay"
    role="presentation"
    tabindex="-1"
    onclick={(e) => {
      if (e.target === e.currentTarget) open = false;
    }}
    onkeydown={onOverlayKey}
  >
    <div class="modal">
      <div class="modal-title">{title}</div>
      <div class="modal-body">{@render children?.()}</div>
      <div class="modal-foot">
        <button class="btn" type="button" onclick={() => (open = false)}>{$t('取消')}</button>
        <button class="btn {danger ? 'danger' : 'primary'}" type="button" onclick={onconfirm}>
          {$t(confirmText)}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    min-width: min(360px, 90vw);
    max-width: 90vw;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }
  .modal-title {
    padding: 14px 18px;
    font-weight: 600;
    border-bottom: 1px solid var(--border);
  }
  .modal-body {
    padding: 16px 18px;
    color: var(--text);
  }
  .modal-body :global(p) {
    margin: 0;
  }
  .modal-body :global(input.input) {
    display: block;
    width: 100%;
    min-width: 0;
  }
  .modal-foot {
    padding: 12px 18px;
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    border-top: 1px solid var(--border);
  }
</style>
