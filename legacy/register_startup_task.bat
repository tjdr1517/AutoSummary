@echo off
setlocal

set "TASK_NAME=CoolMessengerAutoSummary"
set "SCRIPT_DIR=%~dp0"
set "PYTHON_EXE="

for /f "delims=" %%I in ('where python 2^>nul') do (
  set "PYTHON_EXE=%%I"
  goto :found_python
)

:found_python
if "%PYTHON_EXE%"=="" (
  echo [ERROR] python.exe not found in PATH.
  exit /b 1
)

set "TASK_CMD=\"%PYTHON_EXE%\" \"%SCRIPT_DIR%cm_auto_summary.py\" --interval 5 --bootstrap latest"
schtasks /Create /F /SC ONLOGON /RL LIMITED /TN "%TASK_NAME%" /TR "%TASK_CMD%"

if errorlevel 1 (
  echo [ERROR] Failed to register task: %TASK_NAME%
  exit /b 1
)

echo [OK] Registered startup task: %TASK_NAME%
echo [INFO] It will run at Windows logon.
