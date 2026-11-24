'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const root = path.resolve(__dirname, '..');
const cache = path.join(__dirname, 'build', 'cache');

function prepareBuildInput(kind, args = [], python = process.env.BAAS_PYTHON) {
  const executable = python || path.join(root, '.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return new Promise((resolve, reject) => {
    const marker = 'YAB_BUILD_INPUT ';
    const child = spawn(executable, ['-B', '-m', 'desktop.build_cache', kind,
      '--cache', cache, '--node-version', process.version, ...args], {
      cwd: root, windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output;
    createInterface({ input: child.stdout }).on('line', line => {
      if (line.startsWith(marker)) output = line.slice(marker.length);
      else console.log(line);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0 || !output) {
        reject(new Error('准备桌面构建产物失败，退出状态 ' + (signal || code)));
        return;
      }
      try { resolve(JSON.parse(output)); }
      catch (error) { reject(error); }
    });
  });
}

module.exports = { cache, prepareBuildInput };
