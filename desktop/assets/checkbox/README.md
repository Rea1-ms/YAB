# 安装器复选框素材

原始图形来自 [Fluent UI System Icons（微软系统图标库）](https://github.com/microsoft/fluentui-system-icons)，
固定版本为 `e15fc0de25fab983e3e42bac8798be69a85c23bf`。许可原文保存在 LICENSE.txt（许可文件）。

source（原始素材目录）保留上游 16 像素的未勾选、勾选和半选矢量图，图形路径没有改写。
生成的图片只保留透明度轮廓，颜色由原生插件根据主题及控件状态设置。
资源随插件一起嵌入，用户运行安装器时不依赖外部图片路径。

在 desktop（桌面目录）运行 `node generate_checkbox_assets.cjs`（重新生成复选框素材），
使用项目已有的桌面运行环境渲染，生成 16、20、24、28、32、40、48、56、64 像素图片。
普通发行直接使用已保存的图片，不联网或重新生成。
生成后再重建原生插件，并重新生成安装包和完整压缩包。

原图和生成头文件受 desktop/.gitattributes（桌面换行约定）约束，固定为 LF（换行格式）。
构建前校验原图、图片及头文件摘要；提交时也核对暂存与检出后的字节，避免自动换行转换破坏校验。
更完整的构建、卸载残留与发行核对说明见仓库 docs/develop_doc/desktop_installer.md（桌面安装器维护）。

资源、颜色和尺寸分开管理的方式参考了
[WPF UI（桌面界面库）](https://github.com/lepoco/wpfui/blob/main/src/Wpf.Ui/Resources/Fonts.xaml)
和 [FluentIcons（多框架图标封装）](https://github.com/davidxuang/FluentIcons)。
本项目直接使用微软原始图形，没有引入这两个项目的控件框架或复制其代码。
