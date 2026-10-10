@echo off
setlocal
cd /d "%~dp0"
echo ================================================
echo Agent21 local AI / media diagnostics
echo ================================================
echo.
echo Ollama models:
ollama list
echo.
echo FFmpeg:
where ffmpeg >nul 2>&1
if errorlevel 1 (echo NOT FOUND - video analysis will fail) else (ffmpeg -version | findstr /B /C:"ffmpeg version")
echo FFprobe:
where ffprobe >nul 2>&1
if errorlevel 1 (echo NOT FOUND - video analysis will fail) else (ffprobe -version | findstr /B /C:"ffprobe version")
echo.
echo Agent21 backend media diagnostics:
curl -sS http://127.0.0.1:3002/api/agent/media/diagnostics
echo.
echo.
pause
endlocal
