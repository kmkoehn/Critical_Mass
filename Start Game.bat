@echo off
rem Double-click to play Critical Mass in your web browser.
rem Keep this window open while you play; close it to stop the game.
title Critical Mass
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo Node.js is needed to run the game. Install it from https://nodejs.org and try again.
    pause
    exit /b 1
)

if not exist node_modules (
    echo First run: installing the game's packages. This takes a minute...
    call npm install
    if errorlevel 1 (
        echo Could not install the packages.
        pause
        exit /b 1
    )
)

echo Starting Critical Mass. Your browser will open in a moment.
echo Close this window to stop the game.
call npx vite --open
pause
