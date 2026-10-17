@echo off
setlocal
cd /d "%~dp0"
if exist ".tools\node22\node.exe" (
  ".tools\node22\node.exe" scripts\dev.mjs
) else (
  node scripts\dev.mjs
)
if errorlevel 1 pause
