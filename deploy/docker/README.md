### How to Use Docker

> This project aims to support Docker deployment, but currently, the Docker deployment is not functioning properly. If you have a solution, please submit a PR.

1. Ensure Docker is installed on your computer, and clone this project to your local machine.
2. Navigate to the project directory, copy this folder to the project root, and build the image:
    ```shell
    docker build -t baas:v1.0 .
    ```
3. Method 1 for running the container: using `docker run`
    ```shell
    docker run -it -v "$PWD:/app" -p 22267:22267 -e BAAS_WEBUI_TOKEN baas:v1.0
    ```
4. Method 2 for running the container: using `docker-compose`
    ```shell
    docker-compose up -d
    ```
5. Set `BAAS_WEBUI_TOKEN` before starting; keep the password out of the repository.（启动前设置网页访问密码环境变量，不要把密码写入仓库。）
6. Open `http://127.0.0.1:22267` and log in with that password. The first launch prepares the web assets and needs network access.（浏览器打开网页地址并输入密码登录，首次准备网页资源需要联网。）
