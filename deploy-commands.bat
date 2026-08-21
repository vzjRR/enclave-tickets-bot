@echo off
setlocal

cd /d "%~dp0"
title Enclave RP - Deploy Slash Commands

echo Registering Enclave RP slash commands with Discord...
call npm run deploy
if errorlevel 1 (
  echo.
  echo Failed to register commands. Check DISCORD_TOKEN and CLIENT_ID in .env
  pause
  exit /b 1
)

if not exist "data" mkdir "data"
echo deployed> "data\.commands-deployed"

echo.
echo Commands registered.
pause
