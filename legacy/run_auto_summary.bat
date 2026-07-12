@echo off
setlocal
set SCRIPT_DIR=%~dp0
python "%SCRIPT_DIR%cm_auto_summary.py" --interval 5 --bootstrap latest
