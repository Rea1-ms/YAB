<script lang="ts">
  import { cubicOut } from 'svelte/easing';
  import { toasts, dismissToast, type Toast } from '../toast';
  import { t as translate } from '../i18n';

  // Keep the deadline beside the rendered notification so its interaction and
  // countdown share one lifetime. Expiry waits for both pointer and focus to leave.
  function lifetime(node: HTMLElement, notification: Toast) {
    let expired = false;
    const closeIfExpired = () => {
      if (expired && !node.matches(':hover') && !node.contains(node.ownerDocument.activeElement)) {
        dismissToast(notification.id);
      }
    };
    const onFocusOut = () => queueMicrotask(closeIfExpired);
    const timeout = setTimeout(() => {
      expired = true;
      closeIfExpired();
    }, notification.duration);
    node.addEventListener('pointerleave', closeIfExpired);
    node.addEventListener('focusout', onFocusOut);
    return {
      destroy() {
        clearTimeout(timeout);
        node.removeEventListener('pointerleave', closeIfExpired);
        node.removeEventListener('focusout', onFocusOut);
      },
    };
  }

  function toastMotion(node: HTMLElement) {
    const style = getComputedStyle(node);
    const height = node.getBoundingClientRect().height;
    return {
      duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180,
      easing: cubicOut,
      css: (t: number) => `
        opacity: ${t};
        transform: translateX(${(1 - t) * 20}px);
        height: ${t * height}px;
        min-height: 0;
        padding-top: ${t * parseFloat(style.paddingTop)}px;
        padding-bottom: ${t * parseFloat(style.paddingBottom)}px;
        border-top-width: ${t * parseFloat(style.borderTopWidth)}px;
        border-bottom-width: ${t * parseFloat(style.borderBottomWidth)}px;
        margin-bottom: ${t * parseFloat(style.marginBottom)}px;
      `,
    };
  }
</script>

<div class="toast-host">
  {#each $toasts as t (t.id)}
    <div class="toast {t.kind}" role="status" use:lifetime={t} transition:toastMotion>
      <span class="toast-timer" aria-hidden="true" style:animation-duration={`${t.duration}ms`}></span>
      <span class="toast-text">{t.text}</span>
      <button class="tclose" type="button" aria-label={$translate('关闭')} onclick={() => dismissToast(t.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  .toast-host {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 200;
    display: flex;
    flex-direction: column;
  }
  .toast {
    background: var(--panel2);
    border: 1px solid var(--border);
    --toast-color: var(--accent);
    position: relative;
    overflow: hidden;
    padding: 10px 14px;
    margin-bottom: 8px;
    border-radius: 8px;
    display: flex;
    gap: 12px;
    align-items: center;
    min-width: min(220px, calc(100vw - 32px));
    max-width: min(420px, calc(100vw - 32px));
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
    font-size: 13px;
  }
  .toast.error {
    --toast-color: var(--danger);
  }
  .toast.success {
    --toast-color: var(--ok);
  }
  .toast-text {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .toast-timer {
    position: absolute;
    inset: 0 0 auto;
    height: 3px;
    background: var(--toast-color);
    transform-origin: left;
    animation: countdown linear forwards;
  }
  .tclose {
    flex: 0 0 20px;
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    margin-left: auto;
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 15px;
    padding: 0;
    line-height: 1;
  }
  .tclose:hover {
    color: var(--text);
  }
  @keyframes countdown {
    from { transform: scaleX(1); }
    to { transform: scaleX(0); }
  }
</style>
