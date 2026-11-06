'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const net = require('net');
const { readWebSettings, probePort } = require('../webui.cjs');

test('desktop shares saved listener settings and validates environment overrides', async () => {
  const output = path.resolve(__dirname, '../../develop_tools/out');
  await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'desktop-listener-'));
  const config = path.join(root, 'custom-config');
  await fs.mkdir(config);
  assert.deepEqual(readWebSettings(root, config, {}), { host: '127.0.0.1', port: 22267 });
  await fs.writeFile(path.join(config, 'webui.json'), JSON.stringify({ host: '::1', port: 23456 }));
  assert.deepEqual(readWebSettings(root, config, {}), { host: '::1', port: 23456 });
  assert.deepEqual(readWebSettings(root, null, { YAB_CONFIG_DIR: config, BAAS_DESKTOP_PORT: '23457' }),
    { host: '::1', port: 23457 });
  for (const override of ['0', '-1', '65536', '3.5', '23456oops']) {
    assert.throws(() => readWebSettings(root, config, { BAAS_DESKTOP_PORT: override }), /BAAS_DESKTOP_PORT/);
  }
  for (const settings of [null, [], { host: 1, port: 2 }, { host: 'invalid', port: 2 },
    { host: '::1', port: true }, { host: '::1', port: 0 }, { host: '::1', port: '22267' }]) {
    await fs.writeFile(path.join(config, 'webui.json'), JSON.stringify(settings));
    assert.throws(() => readWebSettings(root, config, {}), /网页服务设置不合法/);
  }
  await fs.writeFile(path.join(config, 'webui.json'), '{broken');
  assert.throws(() => readWebSettings(root, config, {}), /无法读取网页服务设置/);
});

test('occupied fixed ports fail clearly instead of selecting another port', async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const settings = { host: '127.0.0.1', port: server.address().port };
  try {
    await assert.rejects(probePort(settings), /修改 config\/webui.json/);
  } finally { await new Promise(resolve => server.close(resolve)); }
  await probePort(settings);
});
