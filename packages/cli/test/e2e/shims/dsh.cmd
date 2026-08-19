@echo off
if "%DSHPACK_SHIM_HOLD_STDIO%"=="launcher" (
  start /b "" "%DSHPACK_NODE_EXE%" "%~dp0process-shim.mjs" %*
  exit /b 0
)
"%DSHPACK_NODE_EXE%" "%~dp0process-shim.mjs" %*
