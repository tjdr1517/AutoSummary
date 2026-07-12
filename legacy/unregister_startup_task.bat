@echo off
setlocal

set "TASK_NAME=CoolMessengerAutoSummary"
schtasks /Delete /F /TN "%TASK_NAME%"

if errorlevel 1 (
  echo [ERROR] Failed to delete task: %TASK_NAME%
  exit /b 1
)

echo [OK] Deleted task: %TASK_NAME%
