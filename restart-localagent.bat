@echo off
setlocal
cd /d "%~dp0"

echo ================================================
echo LocalAgent - clean restart
echo ================================================

echo [1/4] Stopping anything listening on 3002 and 5173...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3002" ^| findstr "LISTENING"') do taskkill /PID %%P /T /F >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":5173" ^| findstr "LISTENING"') do taskkill /PID %%P /T /F >nul 2>&1

echo [2/4] Starting the backend from THIS folder...
start "LocalAgent Backend" cmd /k "cd /d %~dp0 && set "LOCALAGENT_PROJECT_ROOT=%~dp0.." && npm start"
timeout /t 3 /nobreak >nul
call "%~dp0check-backend.bat"

echo [3/4] Starting the frontend from THIS folder...
start "LocalAgent Frontend" cmd /k "cd /d %~dp0 && npm run dev"
timeout /t 2 /nobreak >nul

echo [4/4] Open http://localhost:5173 in Chrome.
echo.
echo Workspace root: %~dp0..
echo Backend:        http://localhost:3002/api/workspace/health

echo.
pause
endlocal
