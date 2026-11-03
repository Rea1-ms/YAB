
### Docker 使用方法
> 本项目拟支持Docker部署，但目前Docker部署仍无法正常运行，如有解决方案，请提交PR
1. 确保你的电脑中存在Docker, 先clone本项目到本地
2. 进入项目目录，先将本文件夹复制到项目根目录，构建镜像：
    ```shell
    docker build -t baas:v1.0 .
    ```
3. 运行容器方法一：使用docker run
    ```shell
    docker run -it -v "$PWD:/app" -p 22267:22267 -e BAAS_WEBUI_TOKEN baas:v1.0
    ```
4. 运行容器方法二：使用docker-compose
    ```shell
    docker-compose up -d
    ```
5. 启动前请设置 `BAAS_WEBUI_TOKEN`（网页访问密码环境变量），不要把密码写进仓库。
6. 浏览器访问 `http://127.0.0.1:22267`（网页地址），输入上述密码登录。首次启动会自动准备网页资源，需要联网。
