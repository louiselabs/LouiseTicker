@echo off
title LouiseTicker
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & pause & exit /b 1)
start "" http://localhost:4400
node server.js
pause
