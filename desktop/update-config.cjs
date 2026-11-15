'use strict';

const path = require('node:path');
const fs = require('node:fs');

const RELEASE_URL = 'https://github.com/Rea1-ms/YAB/releases';
const VARIANTS = ['offline', 'lite', 'lite-system'];

function updateConfig(variant = 'offline', url = `${RELEASE_URL}/latest/download/`) {
  if (!VARIANTS.includes(variant)) throw new Error('更新发行类型不合法');
  const base = new URL(url);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)))
      || base.username || base.password || base.search || base.hash) throw new Error('更新地址必须是无凭据的安全地址');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return { variant, url: base.href, channel: variant === 'offline' ? 'latest' : `latest-${variant}` };
}

function installerName(version, variant) {
  if (!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(version)) throw new Error('更新版本号不合法');
  if (!VARIANTS.includes(variant)) throw new Error('更新发行类型不合法');
  return `YAB-${version}-x64${variant === 'offline' ? '' : `-${variant}`}-setup.exe`;
}

// 安装器写入实际目录；解压包没有这个标记，复制到其他目录也不能冒充安装版。
function installedAt(executable, resources) {
  try {
    const location = fs.readFileSync(path.join(resources, 'yab-install-location'), 'utf16le').replace(/^\uFEFF/, '').trim();
    return path.isAbsolute(location) && path.resolve(location).toLowerCase() === path.dirname(path.resolve(executable)).toLowerCase();
  } catch { return false; }
}

async function createUpdateManifest(directory, config, version, notes = '') {
  const { createHash } = require('node:crypto');
  const filename = installerName(version, config.variant);
  const file = path.join(directory, filename);
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const sha512 = hash.digest('base64');
  const url = config.url === `${RELEASE_URL}/latest/download/`
    ? `${RELEASE_URL}/download/v${version}/${filename}` : new URL(filename, config.url).href;
  const info = { version, files: [{ url, sha512, size: (await fs.promises.stat(file)).size }],
    path: url, sha512, releaseDate: new Date().toISOString(), ...(notes ? { releaseNotes: notes } : {}) };
  // JSON 是合法的 YAML 子集；直接写对象避免重新解析或拼接下载清单。
  const manifest = path.join(directory, `${config.channel}.yml`);
  await fs.promises.writeFile(manifest, JSON.stringify(info, null, 2));
  return manifest;
}

module.exports = { RELEASE_URL, VARIANTS, updateConfig, installerName, installedAt, createUpdateManifest };
