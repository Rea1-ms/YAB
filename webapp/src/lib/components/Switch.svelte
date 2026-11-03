<script lang="ts">
  let {
    checked,
    disabled = false,
    label = '开关',
    onchange,
  }: {
    checked: boolean;
    disabled?: boolean;
    label?: string;
    onchange: (v: boolean) => void;
  } = $props();
</script>

<button
  class="switch"
  class:on={checked}
  {disabled}
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={label}
  onclick={() => onchange(!checked)}
>
  <span class="knob"></span>
</button>

<style>
  .switch {
    width: 40px;
    height: 22px;
    border-radius: 999px;
    background: #2c3242;
    border: 1px solid var(--border);
    position: relative;
    cursor: pointer;
    padding: 0;
    transition:
      background 0.15s,
      border-color 0.15s;
    flex: none;
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--muted);
    transition:
      left 0.15s,
      background 0.15s;
  }
  .switch.on {
    background: var(--accent);
    border-color: var(--accent);
  }
  .switch.on .knob {
    left: 20px;
    background: #fff;
  }
  .switch:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
