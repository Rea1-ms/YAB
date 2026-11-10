'use strict';

// Explicit network test; intentionally excluded from the default test command.
// node test/online-smoke.cjs --bundle <backend> [--app <YAB.exe>] [--index aliyun]
const fs = require('fs/promises');
const path = require('path');
const net = require('net');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const { prepareRuntime } = require('../runtime.cjs');
const { saveRuntimeSettings } = require('../runtime-settings.cjs');

const arg = (name, fallback) => {
  const offset = process.argv.indexOf(name);
  return offset < 0 ? fallback : process.argv[offset + 1];
};

async function main() {
  const bundle = path.resolve(arg('--bundle'));
  const output = path.resolve(__dirname, '../../develop_tools/out');
  await fs.mkdir(output, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(output, 'online-smoke-'));
  const data = path.join(scratch, 'data');
  const configRoot = path.join(scratch, 'config');
  const manifest = JSON.parse(await fs.readFile(path.join(bundle, 'bundle.json')));
  const settings = { uvMode: arg('--uv-mode', manifest.uv), uvPath: arg('--uv-path', ''), index: arg('--index', 'pypi') };
  await saveRuntimeSettings(configRoot, data, settings);
  console.log('测试目录：' + scratch);
  let previousMessage;
  const progress = (message, percent) => {
    if (message !== previousMessage) console.log(`${message} (${Math.floor(percent)}%)`);
    previousMessage = message;
  };
  const first = await prepareRuntime(bundle, data, { configRoot, progress, output: text => process.stdout.write(text) });
  const second = await prepareRuntime(bundle, data, { configRoot });
  assert.equal(second.python, first.python);
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
      await new Promise((resolve, reject) => {
        const child = spawn(path.resolve(executable), ['--smoke'], { env, windowsHide: true });
        for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
          logs.push(chunk.toString()); process.stdout.write(chunk);
        });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('真实应用启动失败：' + code)));
      });
      assert.ok(logs.join('').includes('SMOKE OK'));
      await fs.writeFile(path.join(scratch, `launch-${attempt + 1}.log`), logs.join(''));
    }
    report.backendAndOcr = true;
    report.repeatedLaunch = true;
  }
  await fs.writeFile(path.join(scratch, 'result.json'), JSON.stringify(report, null, 2));
  console.log('ONLINE_SMOKE_OK ' + scratch);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
