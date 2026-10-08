@echo off
setlocal
rem Daily station-state backup (roadmap E3). Registered by install-tasks.ps1.
rem Snapshots the SQLite DB + ingest session/audit files under <repo>\backups.
if not exist "%LOCALAPPDATA%\ncsound" mkdir "%LOCALAPPDATA%\ncsound"
node "%~dp0..\backup-state.mjs" --quiet >> "%LOCALAPPDATA%\ncsound\backup.log" 2>&1
