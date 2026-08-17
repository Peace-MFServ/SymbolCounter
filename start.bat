@echo off
setlocal

:: ============================================================
::  Symbol Counter — start.bat
::  Run from the symbol-counter\ folder.
:: ============================================================

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "FRONTEND=%ROOT%frontend"

echo.
echo  MF Services - Symbol Counter
echo  ================================
echo.

:: ── 1. Check Python ──────────────────────────────────────────
where python >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Python not found.
    echo  Install Python 3.10+ from https://python.org
    echo  Make sure to tick "Add Python to PATH" during install.
    pause
    exit /b 1
)
python --version
echo  [OK] Python found

:: ── 2. Check Node ────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Node.js not found.
    echo  Install Node.js 18+ from https://nodejs.org
    echo  Required for the one-time frontend build step.
    pause
    exit /b 1
)
node --version
echo  [OK] Node.js found

:: ── 3. Python dependencies ───────────────────────────────────
echo.
echo  Installing Python dependencies...
cd /d "%BACKEND%"
python -m pip install -r requirements.txt -q
if errorlevel 1 (
    echo  ERROR: pip install failed.
    pause
    exit /b 1
)
echo  [OK] Python dependencies ready

:: ── 4. Frontend: npm install (first run only) ────────────────
echo.
cd /d "%FRONTEND%"

if exist "node_modules" goto skip_install
echo  Installing frontend packages (first run - takes a minute)...
call npm install
if errorlevel 1 (
    echo  ERROR: npm install failed.
    pause
    exit /b 1
)
echo  [OK] Frontend packages installed
goto after_install
:skip_install
echo  [OK] Frontend packages already installed
:after_install

:: ── 5. Frontend: Vite build ──────────────────────────────────
echo.
echo  Building frontend...
call npm run build
if errorlevel 1 (
    echo  ERROR: Frontend build failed - see output above.
    pause
    exit /b 1
)
echo  [OK] Frontend built

:: ── 6. Start backend ─────────────────────────────────────────
echo.
echo  -----------------------------------------------
echo  Starting Symbol Counter...
echo  Open http://localhost:8000 in your browser
echo  Press Ctrl+C to stop
echo  -----------------------------------------------
echo.
cd /d "%BACKEND%"
python -m uvicorn main:app --port 8000

pause
endlocal
