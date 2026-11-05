# BAAS Desktop（Electron 桌面壳 + 系统托盘）

用 Electron 包一层 BAAS WebUI：主进程负责拉起后端 `python -m server`、探测就绪后加载
`http://127.0.0.1:<port>/`，并提供系统托盘常驻。开发时直接运行；发行包会带上后端和素材。

## 目录

```
desktop/
├─ package.json     # 启动、验证和发行包构建入口
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
| `BAAS_ROOT` | 指定已有的源码或后端目录，跳过内置运行环境准备 | 开发期为 `desktop/` 上级 |
| `BAAS_DESKTOP_DATA` | 指定桌面发行包的数据目录 | 系统当前用户的应用数据目录 |

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

## 构建 Windows（视窗系统）安装包

在 64 位系统准备好项目的 Python 3.11（后端运行环境）和前端构建工具，并先按源码方式
启动一次，让识别程序和模型准备完成。然后在本目录执行：

构建前先在仓库根运行 `uv sync --python 3.11`（按锁文件安装后端依赖），避免旧打包工具
与较新版依赖混用，导致生成的后端无法启动。

```powershell
pnpm install --frozen-lockfile
pnpm run dist
```

构建过程先准备网页，再用 PyInstaller（后端打包工具）生成独立后端，最后用
electron-builder（安装包工具）生成可选择安装目录的安装程序。每次产物放在新的
`release/<构建时间>/`（发行输出目录），构建中间文件保留在 `build/`（构建目录）。
`pnpm run pack`（构建解压目录）可只生成应用目录，便于本机验证。
当前生成的安装包不做代码签名。

安装后不需要另装后端运行环境。首次启动会把内置后端和素材复制到当前用户的应用数据
目录，之后从那里运行；升级时保留用户配置和识别设置。构建不会打入现有用户配置、
访问密码、日志或识别程序的仓库元数据。发行包使用内置识别版本，随应用更新。
