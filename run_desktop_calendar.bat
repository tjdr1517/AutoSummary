@echo off
setlocal
set "BASE=%~dp0"
set "PYTHONPATH=%BASE%desktop_app"
python "%BASE%desktop_app\coolcalendar\app.py"
