@echo off
rem Start the ingest control plane so the station health check has something to ask.
rem NCSOUND_PUBLISH=0: the control plane answers /status without publishing to the
rem Liquidsoap harbor, so an off-air station reports "not on air" (exit 1) instead of
rem "unreachable" (exit 2). Going on air is a separate, deliberate act (infra/station-up.sh).
setlocal
set "NCSOUND_PUBLISH=0"
"C:\Users\User\.bun\bin\bun.exe" run --cwd "%~dp0..\..\packages\ingest" start
