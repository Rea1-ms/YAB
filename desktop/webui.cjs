'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');

function readWebSettings(root, configRoot, env = process.env) {
  const directory = configRoot || env.YAB_CONFIG_DIR || path.join(root, 'config');
  const filename = path.join(directory, 'webui.json');
  let settings = { host: '127.0.0.1', port: 22267 };
  if (fs.existsSync(filename)) {
    try { settings = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch { throw new Error(`无法读取网页服务设置：${filename}`); }
  }
  const { host, port } = settings || {};
  if (Object.keys(settings || {}).sort().join(',') !== 'host,port'
      || typeof host !== 'string' || (host !== 'localhost' && net.isIP(host) === 0)
      || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`网页服务设置不合法：${filename}`);
  }
  const override = env.BAAS_DESKTOP_PORT?.trim();
  if (override) {
    if (!/^\d+$/.test(override) || Number(override) < 1 || Number(override) > 65535) {
      throw new Error('BAAS_DESKTOP_PORT 需要填写 1 至 65535 的整数');
    }
    settings.port = Number(override);
  }
  return settings;
}

async function probePort({ host, port }) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => reject(new Error(`无法监听 ${host}:${port}：${error.message}。`
      + '请关闭占用该端口的程序，或修改 config/webui.json 中的端口。')));
    probe.listen(port, host, () => probe.close(resolve));
  });
}

module.exports = { readWebSettings, probePort };
