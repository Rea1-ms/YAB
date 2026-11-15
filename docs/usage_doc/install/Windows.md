# 在Windows操作系统安装BAAS
::: tip
还没下载？来[这里](../downloads)
:::

## 选择合适的安装包
BAAS提供以下三种安装包
### .exe安装包
   - ![exe_installer.png](/assets/install/exe_installer.png)
    - **description**: `deploy/installer/installer.py` 打包出的安装包, 体积最小, 需要安装python环境, clone仓库
    - **operation**: 下载后双击运行即可

### fulL_env的安装包 (**最为推荐下载**)
   - ![full_env_installer.png](/assets/install/full_env_installer.png)
   - **description**: .exe安装包全部运行完毕后压缩后的安装包, 不需要安装环境, 自带四份配置(国服, 国际服, 日服, Steam国际服), 
   - **operation**: 下载后解压, 双击运行`BlueArchiveAutoScript.exe`即可
   
### with_config（附带配置）安装包
   - ![with_config_installer.png](/assets/install/with_config_installer.png)
   - **description**: .exe安装包 与 setup.toml (安装配置) 一起压缩的安装包 
   - **description**: .exe安装包 , setup.toml (安装配置) , 和四份运行配置(国服, 国际服, 日服, Steam国际服)一起压缩的安装包 
   - **operation**: 下载后解压，可按[安装配置](./setup_config)修改 `setup.toml`（安装配置文件），再双击运行 `BlueArchiveAutoScript.exe`（安装与启动程序）。

## 简易安装教程

- 解压Release或[qq交流群](/usage_doc/qq_group_regulation)中的安装包，双击`BlueArchiveAutoScript.exe`安装环境，请耐心等待。
安装完成后, BAAS的UI界面将自动启动。
- [视频教程](https://www.acfun.cn/v/ac47360708_2)

## 问题解答
### 确保安装路径没有中文
- **原因:** 
  - 部分依赖与脚本对非 ASCII 路径兼容性差
- **解决方法**
  - 将BAAS安装路径更改为不含中文的路径

> 注：旧版本使用 Qt GUI 时还有 `QT_QPA_PLATFORM_PLUGIN_PATH` 相关的报错与解决方法，WebUI 版本已移除 Qt，该问题不再存在。
  **因为MUMU模拟器的Qt与Baas兼容，所以在发生冲突无法打开MuMu模拟器时建议在变量值处填写** `MuMu模拟器的Qt目录` 删除变量也可以正常打开MuMu模拟器。

### 双击BlueArchiveAutoScript.exe后命令行界面全黑无反应
- **解决方法** 
1. 打开windows设置
2. 搜索并进入```病毒和威胁防护```
3. 点击```"病毒和威胁防护"设置```栏下的```管理设置```
4. 关闭```实时保护```

- **原因:** 未知, 可能windows误识为病毒


### 安装命令行出现如下报错

![install_request400.png](/assets/install/install_request400.png)

- **解决方法** 
1. 打开**BAAS**安装目录下的setup.toml, 尝试修改[REPO_URL_HTTP](/usage_doc/install/setup_config#repo-url-http)为其他地址 (gitcode / github)
![setup_toml_REPO_URL_HTTP.png](/assets/install/setup_toml_REPO_URL_HTTP.png)

此外，您也可以使用Github加速站点，即，将 `REPO_URL_HTTP` 的值替换成如下列表之一（你也可以自行寻找可用的加速站）：

- Gh-Proxy IPV4加速：https://v4.gh-proxy.org/https://github.com/pur1fying/blue_archive_auto_script.git
- Gh-Proxy IPV4/6加速：https://v6.gh-proxy.org/https://github.com/pur1fying/blue_archive_auto_script.git
- Gh-Proxy CDN加速：https://cdn.gh-proxy.org/https://github.com/pur1fying/blue_archive_auto_script.git
- Gh-Proxy 主站加速：https://gh-proxy.org/https://github.com/pur1fying/blue_archive_auto_script.git
- 7ed 加速：https://gh.sevencdn.com/https://github.com/pur1fying/blue_archive_auto_script.git
- GitClone 加速：https://gitclone.com/github.com/pur1fying/blue_archive_auto_script.git
- GithubFast 加速：https://githubfast.com/pur1fying/blue_archive_auto_script.git

> キラメイ 个人推荐：Gh-Proxy 加速与 7ed 加速

- **原因:** 你可能被gitee拒绝服务
