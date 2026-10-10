@echo off
setlocal
curl -sS http://127.0.0.1:3002/api/agent/health
if errorlevel 1 (
  echo.
  echo LocalAgent backend is NOT reachable on port 3002.
  echo Start it with: npm start
  pause
  exit /b 1
)
echo.
echo LocalAgent backend is reachable.
endlocal
