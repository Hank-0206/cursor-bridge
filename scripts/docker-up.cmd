@echo off
chcp 65001 > nul
cd /d "%~dp0.."

where docker > nul 2>&1
if errorlevel 1 (
  echo 未找到 docker，请先安装 Docker Desktop。
  exit /b 1
)

if not exist data mkdir data
docker compose up -d --build
if errorlevel 1 exit /b 1

echo.
echo cursor-bridge 已在 Docker 中启动
echo   面板:  http://127.0.0.1:8318/
echo   日志:  docker compose logs -f
echo   停止:  scripts\docker-down.cmd
echo.
