@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title OpenClaw 监控控制台 — 自动安装

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

REM 自动寻找 OpenClaw 目录
set "TARGET_DIR="
if defined OPENCLAW_STATE_DIR if exist "%OPENCLAW_STATE_DIR%" set "TARGET_DIR=%OPENCLAW_STATE_DIR%"
if not defined TARGET_DIR if defined OPENCLAW_HOME if exist "%OPENCLAW_HOME%" set "TARGET_DIR=%OPENCLAW_HOME%"
if not defined TARGET_DIR if defined USERPROFILE if exist "%USERPROFILE%\.openclaw" set "TARGET_DIR=%USERPROFILE%\.openclaw"
if not defined TARGET_DIR if exist "%SCRIPT_DIR%\..\openclaw.json" (
  for %%I in ("%SCRIPT_DIR%\..") do set "TARGET_DIR=%%~fI"
)
if not defined TARGET_DIR if exist "openclaw.json" set "TARGET_DIR=%CD%"
if not defined TARGET_DIR if defined USERPROFILE set "TARGET_DIR=%USERPROFILE%\.openclaw"

if "%~1" neq "" set "TARGET_DIR=%~1"
if "%TARGET_DIR%"=="" (
  echo.
  echo   无法自动检测 OpenClaw 目录
  echo.
  echo   请指定: install.bat C:\path\to\.openclaw
  echo   或设置: set OPENCLAW_HOME=C:\path\to\.openclaw
  echo.
  pause
  exit /b 1
)

if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
set "SCRIPTS_DEST=%TARGET_DIR%\scripts"
if not exist "%SCRIPTS_DEST%" mkdir "%SCRIPTS_DEST%"

set FILES=api-usage-console.js service.sh start.bat install.bat install.sh
for %%f in (%FILES%) do (
  if exist "%SCRIPT_DIR%\%%f" (
    copy /Y "%SCRIPT_DIR%\%%f" "%SCRIPTS_DEST%\%%f" >nul
  )
)

echo.
echo   安装完成
echo.
echo   目录: %TARGET_DIR%
echo   脚本: %SCRIPTS_DEST%
echo.
echo   启动: 双击 %SCRIPTS_DEST%\start.bat
echo   访问: http://127.0.0.1:18790
echo.
pause
