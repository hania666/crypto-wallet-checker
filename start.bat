@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
start "" http://127.0.0.1:4777
node server.js
pause
