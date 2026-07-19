@echo off
REM KSP Engine Editor launcher (Windows). Double-click me.
cd /d "%~dp0"
if exist "python\python.exe" (
    "python\python.exe" launch.py
) else (
    where py >nul 2>nul && ( py launch.py ) || ( python launch.py )
)
echo.
pause
