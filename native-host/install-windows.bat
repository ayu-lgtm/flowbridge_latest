@echo off
if "%~1"=="" (
  echo Usage: install-windows.bat ^<extensionId^>
  exit /b 1
)

set "HERE=%~dp0"
set "EXT_ID=%~1"

node "%HERE%write-manifest.js" %EXT_ID%
if errorlevel 1 (
  echo Manifest write failed. Is Node.js installed and on PATH?
  exit /b 1
)

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.flowbridge.clipboard" /ve /t REG_SZ /d "%HERE%com.flowbridge.clipboard.json" /f
if errorlevel 1 (
  echo Registry write failed - policy may be blocking HKCU edits.
  exit /b 1
)

echo Done. Ab extension reload karo: chrome://extensions -^> Reload.