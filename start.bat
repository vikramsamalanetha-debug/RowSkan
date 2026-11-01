@echo off
title RowSkan
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

where openssl >nul 2>nul
if not errorlevel 1 goto haveopenssl
if exist "%ProgramFiles%\Git\usr\bin\openssl.exe" set "PATH=%PATH%;%ProgramFiles%\Git\usr\bin"
if exist "%ProgramFiles(x86)%\Git\usr\bin\openssl.exe" set "PATH=%PATH%;%ProgramFiles(x86)%\Git\usr\bin"
where openssl >nul 2>nul
if errorlevel 1 goto noopenssl

:haveopenssl
start "" http://localhost:8080/
node server.js
echo.
echo RowSkan stopped.
pause
exit /b 0

:nonode
echo Node.js is not installed. Install the LTS version from https://nodejs.org then run this again.
pause
exit /b 1

:noopenssl
echo OpenSSL was not found. It is included with "Git for Windows" (https://git-scm.com/download/win).
echo Install that, then run this again.
pause
exit /b 1
