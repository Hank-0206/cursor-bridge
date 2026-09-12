#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 docker，请先安装 Docker。" >&2
  exit 1
fi

mkdir -p data
docker compose up -d --build

port="${PORT:-8318}"
echo ""
echo "cursor-bridge 已在 Docker 中启动"
echo "  面板:  http://127.0.0.1:${port}/"
echo "  日志:  docker compose logs -f"
echo "  停止:  ./scripts/docker-down.sh"
echo ""
