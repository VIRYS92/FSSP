@echo off
cd /d "%~dp0"
if not exist node_modules\vite call npm ci
if errorlevel 1 exit /b 1
node scripts/start-local.mjs
pause
