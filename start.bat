@echo off
title X-Station
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Download it from https://nodejs.org & pause & exit /b 1)
start "" http://localhost:8080
node serve.js
pause
