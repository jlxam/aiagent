@echo off
setlocal
cd /d "%~dp0"

echo [LocalAgent] Stopping stale processes on ports 3002 and 5173...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3002" ^| findstr "LISTENING"') do taskkill /PID %%P /T /F >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":5173" ^| findstr "LISTENING"') do taskkill /PID %%P /T /F >nul 2>&1

if not exist node_modules (
  echo [LocalAgent] Installing dependencies...
  call npm install
  if errorlevel 1 pause & exit /b 1
)

start "LocalAgent Backend" cmd /k "cd /d %~dp0 && set "LOCALAGENT_PROJECT_ROOT=%~dp0.." && npm start"
timeout /t 2 /nobreak >nul
start "LocalAgent Frontend" cmd /k "cd /d %~dp0 && npm run dev"

echo.
echo LocalAgent is starting.
echo Backend:  http://localhost:3002
 echo Frontend: http://localhost:5173
endlocal
