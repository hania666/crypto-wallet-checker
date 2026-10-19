@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies, about a minute...
  call npm install --no-audit --no-fund
)
rem open the browser a few seconds later, once the server is listening
start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & start "" http://127.0.0.1:4777"
echo.
echo Wallet panel: http://127.0.0.1:4777   -- keep this window open while you use it
node server.js
pause
