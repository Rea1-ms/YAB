'use strict';

// 有些宿主环境（如某些开发工具/终端）会向子进程泄漏 ELECTRON_RUN_AS_NODE=1，
// 使 electron 退化成普通 Node 模式启动（process.versions.electron 仍存在，但
// require('electron') 解析到 node_modules 里的 index.js、返回可执行文件路径字符串，
// Electron API 全部不可用）。检测到这种情况就用 electron 本体、去掉该变量后重启自己，
// 保证 `electron .` / `electron . --smoke` 在任何环境行为一致。
{
  const electronModule = require('electron');
  if (typeof electronModule === 'string') {
    const { spawn: respawn } = require('child_process');
    const cleanEnv = { ...process.env };
    delete cleanEnv.ELECTRON_RUN_AS_NODE;
    const relaunched = respawn(electronModule, [__dirname].concat(process.argv.slice(2)), {
      stdio: 'inherit',
      env: cleanEnv,
      windowsHide: false,
    });
    relaunched.once('error', (err) => {
      console.error(`无法启动 Electron（${electronModule}）: ${err.message}`);
      process.exit(1);
    });
    relaunched.once('close', (code) => process.exit(code === null ? 1 : code));
    return; // CommonJS 模块顶层 return 合法：把控制权交给重启的进程
  }
}

// YAB 桌面壳（Electron 主进程）：
//   1. 单实例锁；二次启动聚焦已有窗口
//   2. 选端口（BAAS_DESKTOP_PORT 或 net.listen(0) 拿空闲端口）
//   3. 按优先级找 python / 打包产物，以仓库根为 cwd 拉起 `python -m server`
//   4. 轮询 GET /api/health，成功后加载主窗口（此前显示 loading 页）
//   5. 托盘：显示主窗口 / 重新载入页面 / 退出；关窗 = 隐藏到托盘
//   6. 退出时杀后端进程树（Windows: taskkill /T /F，其他: SIGTERM+SIGKILL 兜底）
//   7. `electron . --smoke` 无窗口冒烟模式，供 CI/无头验证
//
// 零构建、无 TypeScript、CommonJS。

const { app, BrowserWindow, Tray, Menu, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { desktopDataPath, prepareRuntime, activateRuntime, readActiveRuntime, restoreSettings } = require('./runtime.cjs');

const dataPath = desktopDataPath(app.getPath('appData'), process.env.BAAS_DESKTOP_DATA);
fs.mkdirSync(dataPath, { recursive: true });
app.setPath('userData', dataPath);

const SMOKE_MODE = process.argv.includes('--smoke');
const HOST = '127.0.0.1';
const HEALTH_PATH = '/api/health';
const READY_TIMEOUT_MS = 90 * 1000; // 后端就绪总预算（首次启动含前端构建时会紧张，见 README）
const POLL_INTERVAL_MS = 500;
const KILL_TIMEOUT_MS = 8 * 1000; // 杀进程树后的等待上限，超时则放弃等待直接退出
const LOG_RING_SIZE = 200; // 后端输出环形缓冲行数，出错时展示尾部

// ------------------------------ 全局状态 ------------------------------

let mainWindow = null;
let tray = null;
let backend = null; // { child, label, healthy }
let backendExit = null; // { code, signal }，后端退出时记录
let quitting = false;
let trayHintShown = false;
let repoRoot = null;
let serverPort = null;
let packagedRuntime = null;
let previousRuntime = null;
let runtimeFallbackMessage = '';
const preparation = new AbortController();
const logLines = []; // 后端 stdout/stderr 环形缓冲

// ------------------------------ 小工具 ------------------------------

const isWindows = () => process.platform === 'win32';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  console.log(`[yab-desktop] ${message}`);
}

function pushBackendLog(chunk) {
  const text = chunk.toString();
  process.stdout.write(text); // 转发到控制台
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    logLines.push(line);
    if (logLines.length > LOG_RING_SIZE) logLines.shift();
  }
}

function logTail(lines = 40) {
  if (logLines.length === 0) return '(后端尚无输出)';
  return logLines.slice(-lines).join('\n');
}

class StartupError extends Error {}

// ------------------------------ 路径与端口 ------------------------------

// 判断某个目录是否像 YAB 仓库根 / 发行包根
function looksLikeRepoRoot(dir) {
  if (!dir || typeof dir !== 'string') return false;
  try {
    return fs.statSync(path.join(dir, 'server', '__main__.py')).isFile();
  } catch {
    return false;
  }
}

// 仓库根解析：开发期 = desktop/ 的上级；打包期 BAAS_ROOT > exe 同级/上级 > resources 及其上级
async function resolveRepoRoot() {
  const fromEnv = process.env.BAAS_ROOT;
  if (fromEnv && fromEnv.trim()) {
    return path.resolve(fromEnv.trim());
  }
  if (app.isPackaged) {
    const bundle = path.join(process.resourcesPath, 'backend');
    if (fs.existsSync(path.join(bundle, 'bundle.json'))) {
      const userData = app.getPath('userData');
      const configRoot = path.resolve(process.env.YAB_CONFIG_DIR || path.join(path.dirname(app.getPath('exe')), 'config'));
      previousRuntime = await readActiveRuntime(userData);
      // A rollback must use the same configuration location as the candidate.
      if (previousRuntime?.configRoot !== configRoot) previousRuntime = null;
      try {
        packagedRuntime = await prepareRuntime(bundle, userData, {
          configRoot, signal: preparation.signal, progress: showPreparation, output: pushBackendLog,
        });
      } catch (error) {
        if (SMOKE_MODE || !previousRuntime || preparation.signal.aborted) throw error;
        packagedRuntime = previousRuntime;
        runtimeFallbackMessage = `新版本准备失败，已使用上一版本。\n${error.message}`;
        log(runtimeFallbackMessage);
      }
      return packagedRuntime.root;
    }
    const exeDir = path.dirname(app.getPath('exe'));
    const candidates = [
      exeDir,
      path.dirname(exeDir),
      process.resourcesPath,
      path.dirname(process.resourcesPath),
    ];
    for (const dir of candidates) {
      if (looksLikeRepoRoot(dir)) return dir;
    }
    log(`打包模式下未在候选目录找到 server/__main__.py，回退使用 exe 目录：${exeDir}`);
    return exeDir;
  }
  // 开发期：desktop/main.js 位于仓库根之下
  return path.resolve(__dirname, '..');
}

// 端口：BAAS_DESKTOP_PORT 优先，否则向系统要一个空闲端口
async function acquirePort() {
  const raw = (process.env.BAAS_DESKTOP_PORT || '').trim();
  if (raw) {
    const port = Number.parseInt(raw, 10);
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return port;
    }
    log(`BAAS_DESKTOP_PORT="${raw}" 不是有效端口，改为自动选择空闲端口`);
  }
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (err) => reject(new StartupError(`探测空闲端口失败：${err.message}`)));
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ------------------------------ 后端可执行文件候选 ------------------------------

// 优先级：①BAAS_PYTHON ②仓库根 .venv 的 python ③仓库根 webui.exe / YAB.exe ④系统 python。
// python 系候选用 `-m server`；打包 exe 候选是 webui.py 冻结产物，CLI 相同但没有 `-m server`。
function backendCandidates(root) {
  if (packagedRuntime) {
    return [{ cmd: packagedRuntime.python, serverArgs: ['-E', '-s', '-B', '-u', '-X', 'utf8', '-m', 'server'], label: '内置独立 Python 环境' }];
  }
  const candidates = [];
  const envPython = (process.env.BAAS_PYTHON || '').trim();
  if (envPython) {
    candidates.push({ cmd: envPython, serverArgs: ['-m', 'server'], label: `BAAS_PYTHON (${envPython})` });
  }
  const venvPython = isWindows()
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
  candidates.push({ cmd: venvPython, serverArgs: ['-m', 'server'], label: `仓库 .venv python (${venvPython})` });
  for (const name of isWindows() ? ['webui.exe', 'YAB.exe', 'BAAS.exe'] : ['webui', 'YAB', 'BAAS']) {
    candidates.push({ cmd: path.join(root, name), serverArgs: [], label: `仓库根打包产物 (${name})` });
  }
  candidates.push({ cmd: isWindows() ? 'python' : 'python3', serverArgs: ['-m', 'server'], label: '系统 python (PATH)' });
  return candidates;
}

// 尝试 spawn 一个候选。spawn 失败（如 ENOENT）返回 null 交给下一个候选。
function trySpawnCandidate(candidate, listenArgs, root) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    const args = candidate.serverArgs.concat(listenArgs);
    try {
      child = spawn(candidate.cmd, args, {
        cwd: root, // server 以仓库根为 cwd（读 config/、src/ 等相对路径）
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      log(`候选不可用 ${candidate.label}: ${err.message}`);
      resolve(null);
      return;
    }
    const giveUp = (reason) => {
      if (settled) return;
      settled = true;
      log(`候选不可用 ${candidate.label}: ${reason}`);
      resolve(null);
    };
    child.once('error', (err) => giveUp(err.message)); // ENOENT 等异步 spawn 失败
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      backendExit = null; // 清掉失败候选可能留下的幽灵退出记录
      log(`后端进程已启动 [PID ${child.pid}]: ${candidate.cmd} ${args.join(' ')} (cwd=${root})`);
      resolve({ child, label: candidate.label });
    });
    // 记录退出信息（只认当前选中的后端进程）：启动期退出用于快速失败，运行期退出用于报错提示
    child.once('exit', (code, signal) => {
      if (backend && backend.child === child) {
        backendExit = { code, signal };
        log(`后端进程退出: code=${code} signal=${signal}`);
      }
    });
    child.stdout.on('data', pushBackendLog);
    child.stderr.on('data', pushBackendLog);
  });
}

// 拉起后端并等待就绪：健康检查通过 / 进程提前退出 / 90s 超时
async function launchBackend(root, port) {
  const listenArgs = ['--host', HOST, '--port', String(port)];
  const attempted = [];
  for (const candidate of backendCandidates(root)) {
    attempted.push(candidate.cmd);
    const started = await trySpawnCandidate(candidate, listenArgs, root);
    if (started) {
      backend = { child: started.child, label: started.label, healthy: false };
      break;
    }
  }
  if (!backend) {
    throw new StartupError(
      '没有找到可用的 YAB 后端可执行文件。尝试过：\n' +
        attempted.map((cmd) => `  - ${cmd}`).join('\n') +
        '\n可设置环境变量 BAAS_PYTHON 指向 YAB 的 python 解释器（需已安装依赖）。',
    );
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (backendExit) {
      throw new StartupError(
        `后端进程提前退出（code=${backendExit.code} signal=${backendExit.signal}）。后端输出尾部：\n${logTail()}`,
      );
    }
    if (await healthCheck(port)) {
      backend.healthy = true;
      log(`后端就绪: http://${HOST}:${port}/`);
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new StartupError(
    `等待后端就绪超时（${READY_TIMEOUT_MS / 1000}s，http://${HOST}:${port}${HEALTH_PATH}）。后端输出尾部：\n${logTail()}`,
  );
}

function healthCheck(port) {
  return new Promise((resolve, reject) => {
    const token = process.env.BAAS_WEBUI_TOKEN;
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const req = http.get({ host: HOST, port, path: HEALTH_PATH, headers, timeout: 3000 }, (res) => {
      if (!packagedRuntime) { res.resume(); resolve(res.statusCode === 200); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('error', () => resolve(false));
      res.on('end', () => {
        try {
          const state = JSON.parse(body);
          if (state.ocr_error) reject(new StartupError(`识别服务初始化失败：${state.ocr_error}`));
          else resolve(res.statusCode === 200 && state.ocr_ready === true);
        } catch { resolve(false); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', () => resolve(false)); // 连接被拒 = 还没起来，继续轮询
  });
}

async function launchPreparedBackend() {
  try {
    await launchBackend(repoRoot, serverPort);
    if (packagedRuntime) await activateRuntime(app.getPath('userData'), packagedRuntime);
  } catch (error) {
    if (SMOKE_MODE || !packagedRuntime || !previousRuntime || packagedRuntime.root === previousRuntime.root) throw error;
    await killBackendTree();
    await restoreSettings(app.getPath('userData'), packagedRuntime);
    packagedRuntime = previousRuntime;
    repoRoot = previousRuntime.root;
    await launchBackend(repoRoot, serverPort);
    runtimeFallbackMessage = `新版本启动失败，已使用上一版本。\n${error.message}`;
    log(runtimeFallbackMessage);
  }
}

// ------------------------------ 退出清理 ------------------------------

// 杀后端进程树：Windows 用 taskkill /T /F，其他平台 SIGTERM（3s 后 SIGKILL）；
// 最多等 KILL_TIMEOUT_MS，超时放弃等待（退出兜底）。
function killBackendTree() {
  return new Promise((resolve) => {
    const child = backend && backend.child;
    backend = null;
    if (!child || child.exitCode !== null || child.signalCode) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const watchdog = setTimeout(finish, KILL_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(watchdog);
      finish();
    });
    if (isWindows()) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', (err) => {
        log(`taskkill 失败（${err.message}），回退 child.kill()`);
        try {
          child.kill();
        } catch {
          /* already dead */
        }
      });
    } else {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 3000).unref();
    }
  });
}

// 统一退出：弹窗（GUI 模式）→ 杀进程树 → app.exit(code)。可重入保护。
async function fatalExit(title, message, code = 1) {
  if (quitting) return;
  quitting = true;
  if (SMOKE_MODE) {
    console.error(message);
  } else {
    try {
      dialog.showErrorBox(title, message);
    } catch (err) {
      console.error(`弹窗失败: ${err.message}\n${message}`);
    }
  }
  await killBackendTree();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  app.exit(code);
}

// ------------------------------ 窗口 / 托盘 ------------------------------

let preparationMessage = 'YAB 启动中…';

function showPreparation(message) {
  preparationMessage = message;
  log(message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(`document.querySelector('p').textContent = ${JSON.stringify(message)}`).catch(() => {});
  }
}

function loadingPageUrl() {
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>YAB</title><style>' +
    'html,body{margin:0;height:100%;background:#0f1115;color:#e6e8ec;' +
    'font-family:"Segoe UI",system-ui,-apple-system,sans-serif}' +
    '.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}' +
    '.spin{width:38px;height:38px;border-radius:50%;border:3px solid #262b36;border-top-color:#4f8cff;' +
    'animation:baas-spin 0.9s linear infinite}' +
    '@keyframes baas-spin{to{transform:rotate(360deg)}}' +
    'p{margin:0;font-size:14px;color:#9aa3b2;letter-spacing:0.5px}' +
    '</style></head><body><div class="wrap"><div class="spin"></div><p>' + preparationMessage + '</p></div></body></html>';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function mainPageUrl() {
  return `http://${HOST}:${serverPort}/`;
}

// 是否是本壳自己的页面（loading data: 页 / 后端本机地址）
function isAppUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true; // data:, about: 等
    const host = parsed.hostname;
    if ((host === '127.0.0.1' || host === 'localhost' || host === '::1') && parsed.port === String(serverPort)) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'logo.ico'),
    title: 'YAB',
    fullscreenable: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(loadingPageUrl());

  // 关闭按钮 = 隐藏到托盘；真正的退出只走托盘菜单 / before-quit
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
    notifyHiddenToTray();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外部域名导航交给系统浏览器
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return mainWindow;
}

function showMainWindow() {
  if (!mainWindow) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// 首次隐藏到托盘时提示一次
function notifyHiddenToTray() {
  if (trayHintShown) return;
  trayHintShown = true;
  const title = 'YAB';
  const text = 'YAB 已最小化到托盘';
  if (isWindows() && tray) {
    tray.displayBalloon({ iconType: 'info', title, content: text });
  } else {
    try {
      new Notification({ title, body: text }).show();
    } catch (err) {
      log(`托盘提示失败: ${err.message}`);
    }
  }
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'logo.ico'));
  tray.setToolTip('YAB');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { label: '重新载入页面', click: () => mainWindow && mainWindow.webContents.reload() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => showMainWindow()); // 托盘单击 = 显示窗口
}

// ------------------------------ 模式入口 ------------------------------

async function runGui() {
  await app.whenReady();
  try {
    createTray();
    createMainWindow();
    repoRoot = await resolveRepoRoot();
    serverPort = await acquirePort();
    log(`仓库根: ${repoRoot}`);
    log(`端口: ${serverPort}`);
    await launchPreparedBackend();
    if (mainWindow) mainWindow.loadURL(mainPageUrl());
    if (runtimeFallbackMessage) dialog.showMessageBox({ type: 'warning', message: '已继续使用上一版本', detail: runtimeFallbackMessage });
  } catch (err) {
    await fatalExit('YAB 启动失败', String((err && err.message) || err));
  }
}

async function runSmoke() {
  app.disableHardwareAcceleration();
  await app.whenReady();
  try {
    repoRoot = await resolveRepoRoot();
    serverPort = await acquirePort();
    console.log(`[smoke] repoRoot=${repoRoot}`);
    console.log(`[smoke] port=${serverPort}`);
    await launchPreparedBackend();
    console.log(`[smoke] health OK: http://${HOST}:${serverPort}${HEALTH_PATH}`);
    console.log('SMOKE OK');
    await killBackendTree();
    app.exit(0);
  } catch (err) {
    console.error(`SMOKE FAIL: ${String((err && err.message) || err)}`);
    await killBackendTree();
    app.exit(1);
  }
}

// ------------------------------ 生命周期 ------------------------------

app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  preparation.abort();
  event.preventDefault();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  killBackendTree().finally(() => app.exit(0));
});

// 后端运行期意外退出：报错并退出（而不是留一个连不上后端的空窗口）。
// 注意不能在这里清空 backend——fatalExit → killBackendTree 还需要它拿到子进程句柄。
if (!SMOKE_MODE) {
  const watchBackendHealth = setInterval(() => {
    if (backend && backend.healthy && backendExit && !quitting) {
      fatalExit(
        'YAB 后端已退出',
        `后端进程意外退出（code=${backendExit.code} signal=${backendExit.signal}）。后端输出尾部：\n${logTail()}`,
      );
    }
  }, 1000);
  watchBackendHealth.unref();
}

// 托盘常驻：关掉所有窗口不退出（macOS 行为简化为与 Windows 一致，见 README）
app.on('window-all-closed', () => {});

if (SMOKE_MODE) {
  runSmoke();
} else if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => showMainWindow());
  runGui();
} else {
  log('已有 YAB 实例在运行，本次启动只聚焦已有窗口');
  app.quit();
}
