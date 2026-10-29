@echo off
rem Production agent. Restarts 10 seconds after it exits. Log: data\production\agent.log
rem Start it through run-hidden.vbs (no window). Keep this file ASCII only.
cd /d "%~dp0"
if not exist data\production mkdir data\production
:loop
node --env-file=.env.production src\index.ts >> data\production\agent.log 2>&1
timeout /t 10 /nobreak >nul
goto loop
