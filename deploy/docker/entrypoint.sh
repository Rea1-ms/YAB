#!/bin/sh
set -eu

: "${BAAS_WEBUI_TOKEN:?请设置 BAAS_WEBUI_TOKEN 环境变量作为网页访问密码}"

exec "$@"
