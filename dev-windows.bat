@echo off
rem Development mode: backend with auto-reload (3001) + Vite dev server with hot reload (5173).
cd /d "%~dp0"
start "ClipForge backend" cmd /k "npm.cmd --prefix backend run dev"
start "ClipForge frontend" cmd /k "npm.cmd --prefix frontend run dev"
timeout /t 4 >nul
start "" http://localhost:5173
