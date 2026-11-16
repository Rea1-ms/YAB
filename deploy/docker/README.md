# Docker（容器部署）

部署步骤统一维护在 [README_CN.md（中文部署说明）](README_CN.md)，包含构建启动、设备连接、配置保存和验证范围。

在项目根目录设置 `BAAS_WEBUI_TOKEN`（网页访问密码环境变量）后，运行：

```shell
docker compose -f deploy/docker/docker-compose.yaml up --build -d --wait --wait-timeout 180
```

当前镜像面向 Linux amd64（常见电脑的 64 位架构），网页和识别资源在构建时准备。完整容器运行仍待实际容器环境验证。
