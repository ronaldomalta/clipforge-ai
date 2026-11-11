@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title ClipForge AI - Instalacao

echo.
echo  ===== ClipForge AI - instalacao =====
echo.

where node >nul 2>&1 || (echo [X] Node.js nao encontrado. Instale o Node.js 22 LTS ou 24 LTS em https://nodejs.org & pause & exit /b 1)
where ffmpeg >nul 2>&1 || echo [!] FFmpeg nao esta no PATH. Instale com: winget install Gyan.FFmpeg  ^(ou defina FFMPEG_PATH no backend\.env^)

set "PY=python"
where py >nul 2>&1 && set "PY=py -3"
%PY% --version >nul 2>&1 || (echo [X] Python nao encontrado. Instale o Python 3.12 em https://python.org marcando "Add to PATH". & pause & exit /b 1)

echo [1/4] Dependencias do backend...
call npm.cmd --prefix backend install --no-audit --no-fund || goto :fail
echo [2/4] Dependencias do frontend...
call npm.cmd --prefix frontend install --no-audit --no-fund || goto :fail

echo [3/4] Ambiente Python (ai-service\.venv)...
if not exist "ai-service\.venv\Scripts\python.exe" (
  %PY% -m venv ai-service\.venv || goto :fail
)
set "VPY=ai-service\.venv\Scripts\python.exe"
"%VPY%" -m pip install --upgrade pip >nul
"%VPY%" -m pip install "numpy>=1.26,<3" "yt-dlp>=2025.1.1" || goto :fail

echo.
echo  O faster-whisper (transcricao e legendas) instala ~150 MB de pacotes.
echo  Os modelos de IA NAO sao baixados agora: voce escolhe e baixa em Configuracoes ^> Diagnostico.
choice /C SN /M "Instalar o faster-whisper agora"
if errorlevel 2 goto :skipwhisper
"%VPY%" -m pip install "faster-whisper>=1.1,<2" || echo [!] Falha ao instalar o faster-whisper. Voce pode tentar de novo depois.
:skipwhisper

echo [4/4] Compilando a interface...
call npm.cmd --prefix frontend run build || goto :fail

if not exist "backend\.env" if exist ".env.example" copy ".env.example" "backend\.env" >nul

echo.
node scripts\doctor.mjs
echo.
echo  Instalacao concluida. Para abrir: start-clipforge.bat
pause
exit /b 0

:fail
echo.
echo [X] A instalacao falhou. Veja a mensagem acima.
pause
exit /b 1
