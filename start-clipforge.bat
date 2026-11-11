@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title ClipForge AI

where node >nul 2>&1 || (echo [X] Node.js nao encontrado. Rode install-windows.bat primeiro. & pause & exit /b 1)
if not exist "backend\node_modules" (echo [X] Dependencias ausentes. Rode install-windows.bat primeiro. & pause & exit /b 1)

if not exist "frontend\dist\index.html" (
  echo Compilando a interface pela primeira vez...
  call npm.cmd --prefix frontend run build || (echo [X] Falha ao compilar a interface. & pause & exit /b 1)
)

set "PORT=3001"
if exist "backend\.env" for /f "tokens=1,2 delims==" %%A in ('findstr /B "PORT=" "backend\.env"') do set "PORT=%%B"

echo.
echo  ClipForge AI iniciando em http://localhost:%PORT%
echo  Mantenha esta janela aberta enquanto usa o app. Para sair, feche-a ou pressione Ctrl+C.
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:%PORT%'"
node backend\src\index.js
if errorlevel 1 (
  echo.
  echo [X] O servidor parou com erro. Rode: node scripts\doctor.mjs
  pause
)
