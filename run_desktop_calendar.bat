@echo off
setlocal
set "BASE=%~dp0"
set "APP=%BASE%electron_app"
set "BUILT=%APP%\release\win-unpacked\CoolCalendar.exe"

if exist "%BUILT%" (
    start "" "%BUILT%"
    exit /b 0
)

if not exist "%APP%\node_modules" (
    pushd "%APP%"
    call npm install
    if errorlevel 1 exit /b 1
    popd
)

pushd "%APP%"
call npm run dev
popd
