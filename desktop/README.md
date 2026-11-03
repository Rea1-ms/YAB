# BAAS Desktop（Electron 桌面壳 + 系统托盘）

用 Electron 包一层 BAAS WebUI：主进程负责拉起后端 `python -m server`、探测就绪后加载
`http://127.0.0.1:<port>/`，并提供系统托盘常驻。零构建（无 TypeScript、无打包步骤），
CommonJS 直接运行。

## 目录

```
desktop/
├─ package.json     # name baas-desktop；scripts: start / smoke
├─ pnpm-lock.yaml   # 锁定依赖（electron ^45）
├─ main.js          # 主进程全部逻辑（后端管理/窗口/托盘/清理/冒烟）
├─ preload.js       # contextBridge 暴露 process.versions 等无害信息（window.baasDesktop）
├─ assets/logo.ico  # 从主仓 assets/logo.ico 复制，窗口与托盘图标
└─ README.md
```

`node_modules/` 已被 `desktop/.gitignore` 忽略。注意：Electron 45 起包内不再带
postinstall，`pnpm install` 只装 JS 包；**平台二进制在第一次运行 `electron` 时自动下载**
（`node_modules/electron/dist/`，约 250MB，可用环境变量 `ELECTRON_MIRROR` 指定镜像加速）。

## 开发运行

前置：仓库根执行过 `uv sync --python 3.11`（存在 `.venv`），且 `webapp/dist/index.html`
已构建（`uv run python -m server.frontend`，或任由首次启动自动构建）。

```powershell
# 方式一：仓库根执行
desktop\node_modules\.bin\electron desktop

# 方式二：
cd desktop
pnpm install   # 首次运行 electron 时会自动下载平台二进制
pnpm start
```

## 冒烟模式（CI / 无头验证）

不创建任何窗口，走同一套逻辑：拉起后端 → 轮询 `/api/health` → 成功打印 `SMOKE OK`
退出码 0；失败打印 `SMOKE FAIL` + 原因（含后端输出尾部）退出码 1。退出前会杀掉后端进程树。

```powershell
cd desktop
pnpm run smoke
```

注意：首次运行若 `webapp/dist` 缺失，后端会在启动时构建前端，可能超过 90s 就绪预算；
CI 建议先构建前端再跑 smoke。冒烟模式不申请单实例锁，可与其他实例共存。

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `BAAS_PYTHON` | 指定后端 python 解释器（需已装好依赖） | 不设则用候选链 |
| `BAAS_DESKTOP_PORT` | 固定后端端口 | 自动选取空闲端口 |
| `BAAS_ROOT` | 指定 BAAS 仓库根 / 发行包根（打包期用） | 开发期为 `desktop/` 上级；打包期为 exe 同级/上级目录探测 |

后端可执行文件候选优先级（`main.js` 的 `backendCandidates`）：

1. `BAAS_PYTHON`
2. `<仓库根>/.venv/Scripts/python.exe`（Windows）/ `.venv/bin/python`（其他）
3. `<仓库根>/webui.exe` / `BAAS.exe`（PyInstaller 打包产物，参数不含 `-m server`）
4. 系统 `python`（PATH）

server 始终以仓库根为 cwd 启动（它按相对路径读 `config/`、`src/`、`webapp/dist`）。

## 行为说明

- **单实例**：`app.requestSingleInstanceLock`，二次启动聚焦已有窗口。
- **窗口**：1280×800（min 960×640），深色背景；就绪前显示内置 loading 页（"BAAS 启动中…"）。
  页面内导航到外部域名会用系统浏览器打开（`will-navigate` / `setWindowOpenHandler`）。
- **托盘**：右键菜单 = 显示主窗口 / 重新载入页面 / 退出；左键单击 = 显示窗口。
  点窗口关闭按钮 = 隐藏到托盘（首次隐藏弹气泡提示）。**真正的退出只有托盘菜单一条路**。
- **退出清理**：`before-quit` / 托盘退出时，Windows 用 `taskkill /PID <pid> /T /F` 杀
  进程树，其他平台 `SIGTERM`（3s 后 `SIGKILL`），最多等 8s 兜底退出。
- **后端崩溃**：运行期后端进程退出会弹错误框（附最近 200 行输出尾部）并退出整个应用。
- **环境自愈**：若宿主环境泄漏了 `ELECTRON_RUN_AS_NODE=1`（某些开发工具的终端会这样），
  main.js 检测到后自动以干净环境用 electron 本体重启自己，`pnpm start` / `pnpm run smoke`
  行为不受影响。
- **macOS**：行为简化为与 Windows 一致（关闭隐藏到托盘、托盘菜单退出），未做 Dock 菜单
  等 macOS 惯例适配。

## 打包思路（未实现）

用 electron-builder 打 Windows NSIS 安装包时的要点：

- 打包时 `BAAS_ROOT` 之外还要带上**运行所需的一切**：`webapp/dist`（前端产物，server 启动
  时 `ensure_frontend` 发现缺失会尝试现场构建——发行包里没有 node/pnpm 时直接报错）、
  `src/`（图像模板等静态资源）、`core/`、`module/`、`server/` 等 python 代码。
- python 环境有两条路线：
  1. **带 `.venv` 整目录**：把仓库根的 `.venv` 与代码一起放进安装目录，`BAAS_ROOT` 指向
     该目录，desktop 直接用 `.venv/Scripts/python.exe`。venv 是绝对路径固定的，换安装
     目录后部分入口脚本会失效，稳妥做法是用 `python -m server`（我们正是这么调用的，
     `python.exe` 本体可搬迁，只要 venv 内启用 `include-system-site-packages=false` 且代码
     全部走 `-m`/cwd 相对路径即可）。
  2. **PyInstaller 产物**：先把 server 冻结成 `webui.exe`（见 `deploy/standalone/`），
     electron-builder 只分发 electron 壳 + `webui.exe` + 静态资源，desktop 的候选 ③ 会
     直接命中它（spawn 参数自动去掉 `-m server`）。
- `assets/logo.ico` 已复制到 `desktop/assets/`，可直接作 electron-builder 的 `icon`。
- electron-builder `build` 配置字段示例（**未验证**，仅示意）：

```jsonc
{
  "appId": "org.baas.desktop",
  "productName": "BAAS",
  "directories": { "output": "release" },
  "files": ["main.js", "preload.js", "assets/**"],
  "extraResources": [
    { "from": "../webapp/dist", "to": "webapp/dist" },
    { "from": "../src", "to": "src" },
    { "from": "../.venv", "to": ".venv" }
    // 以及 core/ module/ server/ config 模板等运行所需目录
  ],
  "win": { "target": [{ "target": "nsis", "arch": ["x64"] }], "icon": "assets/logo.ico" },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true }
}
```

打包后首启时若资源放在 `resources/` 下，`resolveRepoRoot()` 会在 exe 同级、上级及
`resources` 目录里探测 `server/__main__.py`；也可用 `BAAS_ROOT` 显式指定。
