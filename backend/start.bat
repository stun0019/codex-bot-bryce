@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    where py >nul 2>nul
    if not errorlevel 1 (
        py -3.12 -m venv .venv
    ) else (
        python -m venv .venv
    )
    if errorlevel 1 (
        echo Python 3.12 is required.
        pause
        exit /b 1
    )
    .venv\Scripts\python.exe -m pip install -r requirements.txt
    if errorlevel 1 (
        echo Dependency installation failed.
        pause
        exit /b 1
    )
)
echo Open http://127.0.0.1:8000 in your browser.
.venv\Scripts\python.exe -m uvicorn codex_bot.server:app --host 127.0.0.1 --port 8000
pause
