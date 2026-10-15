@echo off
rem codex-campus - one-command entry: guided setup on first run, then Codex
rem through the local filtering proxy (isolated CODEX_HOME).
node "%~dp0bin\cli.js" codex %*
