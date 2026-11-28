'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after } = require('node:test');

const root = path.resolve(__dirname, '../..');

async function outputDirectory(...parts) {
  let directory = await fs.realpath(root);
  for (const part of ['develop_tools', 'out', ...parts]) {
    directory = path.join(directory, part);
    await fs.mkdir(directory).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('测试输出必须保存在项目目录内：' + directory);
    }
  }
  return directory;
}

async function removeScratch(directory) {
  const resolved = await fs.realpath(directory).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!resolved) return;
  if (resolved !== directory) throw new Error('测试临时目录位置已变更：' + directory);
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function archiveTestResults() {
  const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const result = spawnSync(python, ['-B', '-m', 'develop_tools.test_output'], { cwd: root, stdio: 'inherit' });
  if (result.error && result.error.code !== 'ENOENT') console.warn(result.error);
}

async function saveReports(directory, patterns) {
  let destination;
  for await (const filename of fs.glob(patterns, { cwd: directory })) {
    const source = path.join(directory, filename);
    if (!(await fs.lstat(source)).isFile() || await fs.realpath(source) !== source) continue;
    destination ||= await fs.mkdtemp(path.join(await outputDirectory('results', 'desktop-tests'),
      'run-' + path.basename(directory) + '-'));
    const target = path.join(destination, filename);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
  if (destination) {
    await fs.writeFile(path.join(destination, '.complete'), '');
    console.log('桌面回归报告：' + destination);
  }
}

function testDirectories(reportPatterns = []) {
  const directories = [];
  after(() => Promise.all(directories.map(async directory => {
    if (reportPatterns.length) await saveReports(directory, reportPatterns);
    if (process.env.YAB_KEEP_TEST_SCRATCH === '1') console.log('保留桌面回归临时目录：' + directory);
    else await removeScratch(directory);
  })));
  return async prefix => {
    const directory = await fs.mkdtemp(path.join(await outputDirectory('tmp'), prefix));
    directories.push(directory);
    return directory;
  };
}

if (require.main === module) archiveTestResults();

module.exports = { archiveTestResults, outputDirectory, removeScratch, testDirectories };
