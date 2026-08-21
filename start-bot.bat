@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"
title Enclave RP - Tickets Bot

echo ========================================
echo Enclave RP - Tickets Bot
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not added to PATH.
  echo Install Node.js 18 or newer, then run this file again.
  pause
  exit /b 1
)

if not exist ".env" (
  echo No .env file found.
  echo Copy .env.example to .env and fill in DISCORD_TOKEN and CLIENT_ID.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing packages from package-lock.json...
  call npm ci
  if errorlevel 1 (
    echo Failed to install packages.
    pause
    exit /b 1
  )
)

REM Slash commands only need registering once, or after they change.
REM Run deploy-commands.bat to force a re-registration.
if not exist "data\.commands-deployed" (
  echo Registering Discord slash commands...
  call npm run deploy
  if errorlevel 1 (
    echo Failed to register Discord commands.
    pause
    exit /b 1
  )
  if not exist "data" mkdir "data"
  echo deployed> "data\.commands-deployed"
)

:run
echo.
echo Starting bot...
call npm start

echo.
echo Bot stopped. Restarting in 10 seconds - close this window to stop.
timeout /t 10 >nul
goto run
