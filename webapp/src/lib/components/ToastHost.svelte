<script lang="ts">
  import { toasts, dismissToast } from '../toast';
</script>

<div class="toast-host">
  {#each $toasts as t (t.id)}
    <div class="toast {t.kind}" role="status">
      <span>{t.text}</span>
      <button class="tclose" type="button" onclick={() => dismissToast(t.id)}>×</button>
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
    gap: 8px;
  }
  .toast {
    background: var(--panel2);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    padding: 10px 14px;
    border-radius: 8px;
    display: flex;
    gap: 12px;
    align-items: center;
    min-width: 220px;
    max-width: 420px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
    animation: slide-in 0.18s ease-out;
    font-size: 13px;
  }
  .toast.error {
    border-left-color: var(--danger);
  }
  .toast.success {
    border-left-color: var(--ok);
  }
  .tclose {
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
  @keyframes slide-in {
    from {
      transform: translateX(20px);
      opacity: 0;
    }
    to {
      transform: none;
      opacity: 1;
    }
  }
</style>
