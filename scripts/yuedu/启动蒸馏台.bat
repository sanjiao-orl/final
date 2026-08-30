@echo off
chcp 65001 >nul
title yuedu-distill
rem ===== 双击启动：自动装依赖 + 起本地服务 + 开浏览器 =====
where node >nul 2>nul
if errorlevel 1 (
  echo [yuedu] 未检测到 Node.js，请先安装：https://nodejs.org/
  pause
  exit /b 1
)
cd /d "%~dp0"
if not exist node_modules (
  echo [yuedu] 首次运行，安装依赖中（约十几秒）...
  call npm install --no-audit --no-fund --loglevel=error
  if errorlevel 1 (
    echo [yuedu] 依赖安装失败，检查网络后重试
    pause
    exit /b 1
  )
)
echo [yuedu] 启动中，浏览器将自动打开 http://127.0.0.1:8765 （关闭本窗口即停止服务）
node gui-server.mjs
pause
