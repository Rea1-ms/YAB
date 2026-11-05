'use strict';

const fs = require('fs/promises');
const path = require('path');

async function prepareRuntime(bundle, userData) {
  const manifest = JSON.parse(await fs.readFile(path.join(bundle, 'bundle.json'), 'utf8'));
  if (typeof manifest.id !== 'string' || !manifest.id) throw new Error('桌面发行包缺少版本标识');
  const target = path.join(userData, 'backend');
  const marker = path.join(target, '.bundle-id');
  let installed = '';
  try { installed = await fs.readFile(marker, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (installed !== manifest.id) {
    await fs.mkdir(target, { recursive: true });
    await fs.cp(bundle, target, { recursive: true, force: true, filter: (source) => {
      const relative = path.relative(bundle, source).replaceAll(path.sep, '/');
      return !/^(config(?:\/|$)|setup\.toml$|.*\.log$)/.test(relative)
        && !/^core\/ocr\/baas_ocr_client\/bin\/(config|output|\.git)(\/|$)/.test(relative);
    } });
    await fs.writeFile(marker, manifest.id, 'utf8');
  }
  await fs.access(path.join(target, 'BAAS.exe'));
  return target;
}

module.exports = { prepareRuntime };
