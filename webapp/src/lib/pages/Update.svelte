<script lang="ts">
  /** 全局页：更新设置（setup.toml）与帮助文档 */
  import { callRpc } from '../stores';
  import { toast } from '../toast';
  import type { CdkTestResult, HelpLangEntry, ShaTestResult, UpdateInfo } from '../types';

  // —— 更新设置 ——
  let info = $state<UpdateInfo | null>(null);
  let cdk = $state('');
  let repo = $state('');
  let shaMethod = $state('');
  let testingCdk = $state(false);
  let testingSha = $state(false);
  let cdkResult = $state<CdkTestResult | null>(null);
  let shaResult = $state<ShaTestResult | null>(null);

  const REPOS: [string, string][] = [
    ['https://github.com/pur1fying/blue_archive_auto_script.git', 'GitHub 主仓库'],
    ['https://gitee.com/pur1fy/blue_archive_auto_script.git', 'Gitee 国内镜像'],
    ['https://gitcode.com/m0_74686738/blue_archive_auto_script.git', 'GitCode 国内镜像'],
    ['https://e.coding.net/g-jbio0266/baas/blue_archive_auto_script.git', '腾讯工蜂 国内镜像'],
  ];

  async function load(): Promise<void> {
    const r = await callRpc<UpdateInfo>('Meta', 'update_get', {});
    if (r) {
      info = r;
      cdk = r.mirrorc_cdk ?? '';
      repo = r.repo_url_http ?? '';
      shaMethod = r.get_remote_sha_method ?? '';
    }
  }

  const editable = $derived(info?.has_setup_toml === true);

  async function applySave(patch: Record<string, unknown>): Promise<UpdateInfo | null> {
    return (await callRpc<UpdateInfo>('Meta', 'update_save', { patch })) ?? null;
  }

  async function saveCdk(): Promise<void> {
    const r = await applySave({ mirrorc_cdk: cdk });
    if (r) {
      info = r;
      cdk = r.mirrorc_cdk ?? '';
      toast('success', 'Mirror酱 CDK 已保存');
    }
  }

  async function saveRepo(url: string): Promise<void> {
    const r = await applySave({ repo_url_http: url });
    if (r) {
      info = r;
      repo = r.repo_url_http ?? '';
    }
  }

  async function saveShaMethod(): Promise<void> {
    if (!info || shaMethod === (info.get_remote_sha_method ?? '')) return;
    const r = await applySave({ get_remote_sha_method: shaMethod });
    if (r) {
      info = r;
      shaMethod = r.get_remote_sha_method ?? '';
      toast('success', 'SHA 获取方式已保存');
    }
  }

  async function testCdk(): Promise<void> {
    testingCdk = true;
    cdkResult = null;
    try {
      cdkResult = (await callRpc<CdkTestResult>('Meta', 'cdk_test', { cdk })) ?? null;
    } finally {
      testingCdk = false;
    }
  }

  async function testSha(): Promise<void> {
    testingSha = true;
    shaResult = null;
    try {
      shaResult = (await callRpc<ShaTestResult>('Meta', 'sha_test', { repo_url_http: repo })) ?? null;
    } finally {
      testingSha = false;
    }
  }

  function cdkSummary(r: CdkTestResult): string {
    try {
      return JSON.stringify(r.data).slice(0, 240);
    } catch {
      return String(r.data);
    }
  }

  // —— 帮助文档 ——
  let helpList = $state<HelpLangEntry[]>([]);
  let helpLang = $state('');
  let helpName = $state('');
  let helpHtml = $state('');

  async function loadHelp(): Promise<void> {
    const r = await callRpc<HelpLangEntry[]>('Meta', 'help_list', {});
    if (r) {
      helpList = r;
      helpLang = r.some((x) => x.lang === 'zh_CN') ? 'zh_CN' : (r[0]?.lang ?? '');
    }
  }

  const langEntry = $derived(helpList.find((x) => x.lang === helpLang) ?? null);

  async function openHelp(name: string): Promise<void> {
    const r = await callRpc<{ html: string }>('Meta', 'help_content', { lang: helpLang, name });
    if (r) {
      helpName = name;
      helpHtml = r.html;
    }
  }

  // 暗色主题注入：白色文字 + 透明背景
  const styledHtml = $derived(
    helpHtml ? '<style>body{color:#e6e6e6;background:transparent}</style>' + helpHtml : '',
  );

  // 挂载时加载（全局页无 dir 依赖）
  $effect(() => {
    void load();
    void loadHelp();
  });
</script>

<div class="page">
  <div class="card sec">
    <h2>更新设置</h2>
    <div class="ver">
      当前版本：<b class="mono">{info?.current_version ?? '…'}</b>
      {#if info && !editable}
        <span class="warn">开发环境，更新设置不可用</span>
      {/if}
    </div>

    <div class="field">
      <label for="upd-cdk">Mirror酱 CDK</label>
      <div class="ctl">
        <div class="row">
          <input
            id="upd-cdk"
            class="input"
            placeholder="MirrorChyan CDK"
            bind:value={cdk}
            disabled={!editable}
            onkeydown={(e) => e.key === 'Enter' && saveCdk()}
          />
          <button class="btn" type="button" disabled={!editable} onclick={() => void saveCdk()}>保存</button>
          <button class="btn" type="button" disabled={!editable || testingCdk} onclick={() => void testCdk()}>
            {testingCdk ? '测试中…' : '测试 CDK'}
          </button>
        </div>
        {#if cdkResult}
          {#if cdkResult.ok}
            <div class="result ok">测试通过：{cdkSummary(cdkResult)}</div>
          {:else}
            <div class="result err">测试失败：{cdkResult.error ?? '未知错误'}</div>
          {/if}
        {/if}
      </div>
    </div>

    <div class="field">
      <label for="upd-repo">Git 更新仓库</label>
      <div class="ctl">
        <select
          id="upd-repo"
          class="input"
          value={repo}
          disabled={!editable}
          onchange={(e) => void saveRepo((e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="" disabled>请选择</option>
          {#each REPOS as [url, label] (url)}
            <option value={url}>{label}</option>
          {/each}
        </select>
        <div class="row">
          <button class="btn" type="button" disabled={!editable || testingSha} onclick={() => void testSha()}>
            {testingSha ? '测试中…' : '测试仓库连接'}
          </button>
        </div>
        {#if shaResult}
          {#if shaResult.ok && shaResult.sha}
            <div class="result ok">
              连接正常：SHA {shaResult.sha.slice(0, 12)}…（耗时 {shaResult.elapsed ?? '?'} 秒）
            </div>
          {:else}
            <div class="result err">连接失败：{shaResult.error ?? shaResult.sha ?? '未知错误'}</div>
          {/if}
        {/if}
      </div>
    </div>

    <div class="field">
      <label for="upd-sha">SHA获取方式</label>
      <div class="ctl">
        <input
          id="upd-sha"
          class="input"
          list="sha-methods"
          placeholder="github_api / mirrorc_api / pygit2"
          bind:value={shaMethod}
          disabled={!editable}
          onblur={() => void saveShaMethod()}
          onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
        />
        <datalist id="sha-methods">
          <option value="github_api"></option>
          <option value="mirrorc_api"></option>
          <option value="pygit2"></option>
        </datalist>
        <div class="help">取远端最新提交 SHA 的方式，保存后用于检查更新</div>
      </div>
    </div>
  </div>

  <div class="card sec">
    <h2>帮助文档</h2>
    {#if helpList.length === 0}
      <div class="dim">暂无帮助文档</div>
    {:else}
      <div class="tabs">
        {#each helpList as entry (entry.lang)}
          <button class="tab" type="button" class:active={helpLang === entry.lang} onclick={() => (helpLang = entry.lang)}>
            {entry.lang}
          </button>
        {/each}
      </div>
      <div class="help-body">
        <div class="files">
          {#each langEntry?.files ?? [] as f (f)}
            <button class="file" type="button" class:active={helpName === f} onclick={() => void openHelp(f)}>
              {f.replace(/\.html$/, '')}
            </button>
          {/each}
        </div>
        <div class="doc">
          {#if helpHtml}
            <iframe title={helpName || '帮助文档'} class="doc-frame" srcdoc={styledHtml}></iframe>
          {:else}
            <div class="dim doc-empty">从左侧选择文档查看</div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .page {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    overflow: auto;
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
  .ver {
    font-size: 13px;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .ver b {
    color: var(--text);
  }
  .warn {
    color: var(--l2);
    font-size: 12px;
    background: rgba(224, 175, 104, 0.08);
    border: 1px solid rgba(224, 175, 104, 0.3);
    border-radius: 6px;
    padding: 2px 10px;
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
    gap: 6px;
  }
  .ctl :global(.input) {
    max-width: 420px;
    width: 100%;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .row .input {
    flex: 1;
  }
  .result {
    font-size: 12.5px;
    border-radius: 6px;
    padding: 6px 10px;
    word-break: break-all;
    max-width: 560px;
  }
  .result.ok {
    color: var(--ok);
    background: rgba(158, 206, 106, 0.08);
    border: 1px solid rgba(158, 206, 106, 0.3);
  }
  .result.err {
    color: var(--danger);
    background: rgba(247, 118, 142, 0.08);
    border: 1px solid rgba(247, 118, 142, 0.3);
  }
  .help {
    color: var(--faint);
    font-size: 12px;
    line-height: 1.5;
  }
  .tabs {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
  }
  .tab {
    border: 1px solid var(--border);
    background: var(--panel2);
    color: var(--muted);
    border-radius: 6px;
    padding: 4px 14px;
    font-size: 12.5px;
    cursor: pointer;
    font-family: var(--mono);
  }
  .tab.active {
    color: var(--accent);
    border-color: var(--accent);
    background: rgba(122, 162, 247, 0.1);
  }
  .help-body {
    display: flex;
    gap: 12px;
    align-items: stretch;
  }
  .files {
    width: 200px;
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 560px;
    overflow: auto;
  }
  .file {
    text-align: left;
    border: 1px solid var(--border);
    background: var(--panel2);
    color: var(--text);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 12.5px;
    cursor: pointer;
    font-family: inherit;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file:hover {
    border-color: var(--accent);
  }
  .file.active {
    color: var(--accent);
    border-color: var(--accent);
  }
  .doc {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel2);
    min-height: 320px;
    display: flex;
  }
  .doc-frame {
    flex: 1;
    width: 100%;
    min-height: 560px;
    border: none;
    border-radius: 8px;
    background: var(--panel2);
    color-scheme: dark;
  }
  .doc-empty {
    margin: auto;
  }
</style>
