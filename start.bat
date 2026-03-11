@echo off
chcp 65001 >nul
title OpenClaw API 监控控制台
cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo 错误: 未找到 node 命令，请先安装 Node.js
  echo 下载: https://nodejs.org/
  pause
  exit /b 1
)

REM 与 service.sh 一致：数据目录 = 脚本所在目录的上级（OpenClaw 根目录）
for %%I in ("%~dp0..") do set "OPENCLAW_STATE_DIR=%%~fI"

echo 正在启动 OpenClaw API 监控控制台...
echo 数据目录: %OPENCLAW_STATE_DIR%
echo 访问: http://127.0.0.1:18790
echo.
echo 按 Ctrl+C 可停止
echo.

node api-usage-console.js
pause
