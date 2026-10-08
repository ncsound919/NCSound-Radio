@echo off
setlocal
rem Periodic station health check (roadmap E4). Registered by install-tasks.ps1.
rem Exit 0 on air / 1 not on air / 2 unreachable; the JSON line is logged.
if not exist "%LOCALAPPDATA%\ncsound" mkdir "%LOCALAPPDATA%\ncsound"
node "%~dp0..\health-check.mjs" >> "%LOCALAPPDATA%\ncsound\health.log" 2>&1
