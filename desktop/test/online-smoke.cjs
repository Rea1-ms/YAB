'use strict';

// Explicit packaged startup test; online bundles may access the network.
// Intentionally excluded from the default test command.
// node test/online-smoke.cjs --bundle <backend> [--app <YAB.exe>] [--index aliyun]
const fs = require('fs/promises');
const path = require('path');
const net = require('net');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const { prepareRuntime, verifyBundle } = require('../runtime.cjs');
const { saveRuntimeSettings } = require('../runtime-settings.cjs');
const { archiveTestResults, outputDirectory, removeScratch } = require('./output.cjs');
const { cache } = require('../build-inputs.cjs');

const arg = (name, fallback) => {
  const offset = process.argv.indexOf(name);
  return offset < 0 ? fallback : process.argv[offset + 1];
};

async function runSmoke(bundle, scratch, destination) {
  const data = path.join(scratch, 'data');
  const configRoot = path.join(scratch, 'config');
  const manifest = JSON.parse(await fs.readFile(path.join(bundle, 'bundle.json')));
  const settings = manifest.format === 3
    ? { uvMode: arg('--uv-mode', manifest.uv), uvPath: arg('--uv-path', ''), index: arg('--index', 'pypi') }
    : null;
  if (settings) await saveRuntimeSettings(configRoot, data, settings);
  let previousMessage;
  const progress = (message, percent) => {
    if (message !== previousMessage) console.log(`${message} (${Math.floor(percent)}%)`);
    previousMessage = message;
  };
  const first = await prepareRuntime(bundle, data, { configRoot, progress, output: text => process.stdout.write(text) });
  const second = await prepareRuntime(bundle, data, { configRoot });
  assert.equal(second.python, first.python);
  assert.equal(first.root, path.join(bundle, 'app'));
  const report = { bundle, settings, runtime: first, reused: true };
  const executable = arg('--app');
  if (executable) {
    const port = await new Promise(resolve => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
    });
    const env = { ...process.env, BAAS_DESKTOP_DATA: data, YAB_CONFIG_DIR: configRoot, BAAS_DESKTOP_PORT: String(port) };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'BAAS_ROOT', 'BAAS_PYTHON', 'BAAS_WEBUI_TOKEN']) delete env[key];
    for (let attempt = 0; attempt < 2; attempt++) {
      const logs = [];
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(path.resolve(executable), ['--smoke'], { env, windowsHide: true });
          for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
            logs.push(chunk.toString()); process.stdout.write(chunk);
          });
          child.once('error', reject);
          child.once('close', code => code === 0 ? resolve() : reject(new Error('真实应用启动失败：' + code)));
        });
      } finally {
        await fs.writeFile(path.join(destination, `launch-${attempt + 1}.log`), logs.join(''));
      }
      assert.ok(logs.join('').includes('SMOKE OK'));
    }
    report.backendAndOcr = true;
    report.repeatedLaunch = true;
  }
  for (const name of ['versions', 'backups', 'updates']) await assert.rejects(fs.access(path.join(data, name)));
  for (const name of ['config', 'core/ocr/baas_ocr_client/bin/config', 'core/ocr/baas_ocr_client/bin/output']) {
    await assert.rejects(fs.access(path.join(bundle, 'app', name)));
  }
  await verifyBundle(bundle, manifest);
  report.noProgramCopies = true;
  report.installationUnchanged = true;
  return report;
}

async function main() {
  const bundle = path.resolve(arg('--bundle'));
  process.env.UV_CACHE_DIR ||= path.join(cache, 'uv');
  archiveTestResults();
  const destination = await fs.mkdtemp(path.join(await outputDirectory('results', 'online-smoke'), 'run-'));
  console.log('启动验证报告：' + destination);
  const scratch = await fs.mkdtemp(path.join(await outputDirectory('tmp'), 'online-smoke-'));
  let report;
  let failure;
  try {
    report = await runSmoke(bundle, scratch, destination);
  } catch (error) {
    failure = error;
    report = { bundle, status: 'error', error: error.stack || String(error) };
  } finally {
    try {
      await fs.copyFile(path.join(scratch, 'data/desktop-setup.log'), path.join(destination, 'desktop-setup.log'))
        .catch(error => { if (error.code !== 'ENOENT') throw error; });
    } finally {
      await removeScratch(scratch);
    }
  }
  await fs.writeFile(path.join(destination, 'result.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(destination, '.complete'), '');
  if (failure) throw failure;
  console.log('ONLINE_SMOKE_OK ' + destination);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
