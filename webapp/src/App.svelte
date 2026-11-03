<script lang="ts">
  import { callRpc, configScan, connected, meta, setActiveDir } from './lib/stores';
  import { navigate, pendingNavDir, PAGES, route } from './lib/router';
  import { toast } from './lib/toast';
  import ToastHost from './lib/components/ToastHost.svelte';
  import Modal from './lib/components/Modal.svelte';
  import Home from './lib/pages/Home.svelte';
  import Schedule from './lib/pages/Schedule.svelte';
  import Settings from './lib/pages/Settings.svelte';
  import Advanced from './lib/pages/Advanced.svelte';

  const current = $derived($route);
  const scan = $derived($configScan);
  const dir = $derived(current?.dir ?? '');
  const page = $derived(current?.page ?? 'home');
  const currentName = $derived(scan.find((c) => c.dir === dir)?.name ?? dir);

  // 路由守卫：新建配置待出现后跳转；空 hash 跳第一个配置；目录失效跳回第一个
  $effect(() => {
    const r = current;
    const list = scan;
    const pend = $pendingNavDir;
    if (pend && list.some((c) => c.dir === pend)) {
      pendingNavDir.set(null);
      navigate(pend, 'home');
      return;
    }
    if (!r) {
      if (list.length > 0) navigate(list[0].dir, 'home');
      return;
    }
    if (list.length > 0 && !list.some((c) => c.dir === r.dir) && pend !== r.dir) {
      navigate(list[0].dir, 'home');
    }
  });

  // 切换激活配置：订阅/退订对应 topic
  $effect(() => {
    if (current) setActiveDir(current.dir);
  });

  // —— 新建 / 重命名 / 删除 ——
  let showAdd = $state(false);
  let newName = $state('');
  let showRename = $state(false);
  let renameValue = $state('');
  let showDelete = $state(false);

  function onConfigChange(e: Event): void {
    const v = (e.currentTarget as HTMLSelectElement).value;
    if (v && v !== dir) navigate(v, page);
  }

  async function doAdd(): Promise<void> {
    const name = newName.trim();
    if (!name) {
      toast('info', '请输入配置名称');
      return;
    }
    const r = await callRpc('ConfigScan', 'add', { name });
    if (r !== undefined) {
      showAdd = false;
      newName = '';
      pendingNavDir.set(name); // 服务端以 name 作为目录名
    }
  }

  async function doRename(): Promise<void> {
    const name = renameValue.trim();
    if (!name) {
      toast('info', '名称不能为空');
      return;
    }
    const r = await callRpc('ConfigScan', 'rename', { config: dir, name });
    if (r !== undefined) showRename = false;
  }

  async function doDelete(): Promise<void> {
    const r = await callRpc('ConfigScan', 'delete', { name: dir });
    if (r !== undefined) showDelete = false;
  }
</script>

<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <div class="logo">BA</div>
      <div>
        <div class="brand-name">BAAS</div>
        <div class="brand-ver">{$meta?.version ?? '…'}</div>
      </div>
    </div>

    <div class="cfg-block">
      <select class="input" value={dir} onchange={onConfigChange} disabled={scan.length === 0}>
        {#each scan as c (c.dir)}
          <option value={c.dir}>{c.name}</option>
        {/each}
      </select>
      <div class="cfg-btns">
        <button class="mini" type="button" onclick={() => { newName = ''; showAdd = true; }}>新建</button>
        <button
          class="mini"
          type="button"
          disabled={!dir}
          onclick={() => {
            renameValue = currentName;
            showRename = true;
          }}
        >
          重命名
        </button>
        <button
          class="mini"
          type="button"
          disabled={!dir || dir === 'default_config'}
          title="default_config 不允许删除"
          onclick={() => (showDelete = true)}
        >
          删除
        </button>
      </div>
    </div>

    <nav class="nav">
      {#each PAGES as p (p.id)}
        <a href={`#/${encodeURIComponent(dir)}/${p.id}`} class:active={page === p.id}>{p.label}</a>
      {/each}
    </nav>

    <div class="side-status">
      <div class="st" title={$connected ? '后端已连接' : '连接断开，自动重连中'}>
        <span class="dot" class:ok={$connected}></span>连接
      </div>
      <div class="st" title={$meta?.ocr_error || ($meta?.ocr_ready ? 'OCR 就绪' : 'OCR 初始化中…')}>
        <span class="dot" class:ok={$meta?.ocr_ready === true}></span>OCR
      </div>
    </div>
  </aside>

  <main class="main">
    {#if !dir}
      <div class="placeholder">{scan.length === 0 ? '等待后端连接…' : '暂无配置'}</div>
    {:else}
      {#key dir}
        {#if page === 'home'}
          <Home {dir} />
        {:else if page === 'schedule'}
          <Schedule {dir} />
        {:else if page === 'settings'}
          <Settings {dir} />
        {:else}
          <Advanced {dir} />
        {/if}
      {/key}
    {/if}
  </main>
</div>

<ToastHost />

<Modal bind:open={showAdd} title="新建配置" confirmText="创建" onconfirm={doAdd}>
  <input
    class="input"
    placeholder="配置名称（同时作为目录名）"
    bind:value={newName}
    onkeydown={(e) => e.key === 'Enter' && doAdd()}
  />
</Modal>

<Modal bind:open={showRename} title={`重命名「${currentName}」`} confirmText="确定" onconfirm={doRename}>
  <input
    class="input"
    placeholder="新的显示名称"
    bind:value={renameValue}
    onkeydown={(e) => e.key === 'Enter' && doRename()}
  />
</Modal>

<Modal bind:open={showDelete} title="删除配置" confirmText="删除" danger onconfirm={doDelete}>
  <p>确认删除配置「{currentName}」？该操作不可恢复。</p>
</Modal>

<style>
  .shell {
    display: flex;
    height: 100vh;
  }
  .sidebar {
    width: 232px;
    flex: none;
    background: var(--panel);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    padding: 14px 12px;
    gap: 14px;
  }
  .brand {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .logo {
    width: 38px;
    height: 38px;
    border-radius: 9px;
    background: var(--accent);
    color: #0f1115;
    font-weight: 800;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
    flex: none;
  }
  .brand-name {
    font-weight: 700;
    font-size: 16px;
    letter-spacing: 1px;
  }
  .brand-ver {
    font-size: 11px;
    color: var(--muted);
    font-family: var(--mono);
  }
  .cfg-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cfg-block :global(select.input) {
    width: 100%;
  }
  .cfg-btns {
    display: flex;
    gap: 6px;
  }
  .cfg-btns .mini {
    flex: 1;
  }
  .nav {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .nav a {
    color: var(--muted);
    text-decoration: none;
    padding: 8px 12px;
    border-radius: 7px;
    font-size: 14px;
    border: 1px solid transparent;
  }
  .nav a:hover {
    color: var(--text);
    background: var(--panel2);
  }
  .nav a.active {
    color: var(--accent);
    background: rgba(122, 162, 247, 0.1);
    border-color: rgba(122, 162, 247, 0.35);
  }
  .side-status {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .st {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    overflow: hidden;
  }
  .placeholder {
    margin: auto;
    color: var(--muted);
  }
</style>
