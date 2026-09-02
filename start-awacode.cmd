@echo off
setlocal EnableExtensions EnableDelayedExpansion

for %%I in ("%~dp0.") do set "AWACODE_ROOT=%%~fI"
cd /d "%AWACODE_ROOT%" || (
  echo [ERROR] Cannot enter the AwaCode project directory.
  exit /b 1
)

set "CHECK_ONLY=0"
if /I "%~1"=="--check" set "CHECK_ONLY=1"
if not "%~1"=="" if /I not "%~1"=="--check" (
  echo Usage: %~nx0 [--check]
  exit /b 2
)

set "NODE_EXE="
if defined AWACODE_NODE_PATH (
  call :accept_node "%AWACODE_NODE_PATH%"
  if not defined NODE_EXE (
    echo [ERROR] AWACODE_NODE_PATH must point to Node.js 24 or newer.
    exit /b 1
  )
) else (
  for /f "delims=" %%N in ('where.exe node 2^>nul') do if not defined NODE_EXE call :accept_node "%%N"
  if not defined NODE_EXE call :accept_node "%ProgramFiles%\nodejs\node.exe"
  if not defined NODE_EXE call :accept_node "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)

if not defined NODE_EXE (
  echo [ERROR] Node.js 24 or newer was not found.
  echo Install Node.js 24 or set AWACODE_NODE_PATH to its node.exe.
  exit /b 1
)

set "TSC=%AWACODE_ROOT%\core\node_modules\typescript\bin\tsc"
set "CORE_ENTRY=%AWACODE_ROOT%\core\dist\index.js"
set "DESKTOP_DIR=%AWACODE_ROOT%\desktop\build-qt6"
set "DESKTOP_EXE=%DESKTOP_DIR%\awacode-desktop.exe"

if not exist "%TSC%" (
  echo [ERROR] Core dependencies are missing.
  echo Run: cd core ^&^& npm ci
  exit /b 1
)
if not exist "%DESKTOP_EXE%" (
  echo [ERROR] The Qt desktop client has not been built.
  echo Follow the Qt build instructions in README.md first.
  exit /b 1
)
if not exist "%DESKTOP_DIR%\Qt6Core.dll" if not exist "%QT_ROOT%\bin\Qt6Core.dll" (
  echo [ERROR] Qt runtime DLLs were not found beside the desktop executable.
  echo Run windeployqt or rebuild the desktop deployment.
  exit /b 1
)
if not exist "%DESKTOP_DIR%\Qt6Widgets.dll" if not exist "%QT_ROOT%\bin\Qt6Widgets.dll" (
  echo [ERROR] Qt Widgets runtime DLLs were not found beside the desktop executable.
  echo Run windeployqt or rebuild the desktop deployment.
  exit /b 1
)

echo Node: %NODE_EXE%
echo Desktop: %DESKTOP_EXE%
if "%CHECK_ONLY%"=="1" (
  echo [OK] AwaCode is ready to start.
  exit /b 0
)

tasklist /FI "IMAGENAME eq awacode-desktop.exe" /NH 2>nul | find.exe /I "awacode-desktop.exe" >nul
if not errorlevel 1 (
  echo [OK] AwaCode is already running.
  exit /b 0
)

echo Building the TypeScript Core...
"%NODE_EXE%" "%TSC%" -p "%AWACODE_ROOT%\core\tsconfig.json"
if errorlevel 1 (
  echo [ERROR] Core build failed.
  exit /b 1
)
if not exist "%CORE_ENTRY%" (
  echo [ERROR] Core build completed without producing core\dist\index.js.
  exit /b 1
)

set "AWACODE_NODE_PATH=%NODE_EXE%"
start "" /D "%AWACODE_ROOT%" "%DESKTOP_EXE%"
if errorlevel 1 (
  echo [ERROR] The Qt desktop client could not be started.
  exit /b 1
)

echo [OK] AwaCode started. The Qt client will start and manage the Core process.
exit /b 0

:accept_node
set "NODE_CANDIDATE=%~1"
if not exist "!NODE_CANDIDATE!" exit /b 0
set "NODE_VERSION="
for /f "tokens=1 delims=." %%V in ('"!NODE_CANDIDATE!" --version 2^>nul') do set "NODE_VERSION=%%V"
if not defined NODE_VERSION exit /b 0
set "NODE_MAJOR=!NODE_VERSION:~1!"
for /f "delims=0123456789" %%V in ("!NODE_MAJOR!") do exit /b 0
if !NODE_MAJOR! LSS 24 exit /b 0
set "NODE_EXE=!NODE_CANDIDATE!"
exit /b 0
