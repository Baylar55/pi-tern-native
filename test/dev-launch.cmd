@echo off
rem Development launcher: runs this checkout's src/ (not an installed copy) plus the test fixture,
rem with an isolated pi config (test\agent: no credentials, the mock model from test\mock-llm.mjs),
rem so nothing typed in a test can reach a real model.
rem Point Tern's agent command (or `tern ctl agent-command`) at this file.
set PI_TERN_NATIVE=1
set PI_OFFLINE=1
set PI_SKIP_VERSION_CHECK=1
set PI_CODING_AGENT_DIR=%~dp0agent
set PI_TERN_HEARTBEAT=1
set PI_TERN_NATIVE_LOG_VERBOSE=1
if "%PI_TERN_NATIVE_LOG%"=="" set PI_TERN_NATIVE_LOG=%TEMP%\pi-tern-dev.jsonl
call pi --no-session -ne -e "%~dp0..\src\index.ts" -e "%~dp0fixture-ext.ts" %*
