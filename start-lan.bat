@echo off
rem Makes the output feeds and ticker page reachable from other machines on your network
rem (e.g. the playout / graphics computer). Editing stays restricted to this computer.
title LouiseTicker (network)
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required: https://nodejs.org & pause & exit /b 1)
set LAN=1
start "" http://localhost:4400
node server.js
pause
