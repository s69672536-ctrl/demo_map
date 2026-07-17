@echo off
echo Starting Puthusu Collection System...

start "Backend" cmd /k "cd /d D:\AI---ML\16\backend && py -m uvicorn app.main:app --reload --host 0.0.0.0"

timeout /t 3 /nobreak >nul

start "Admin Dashboard" cmd /k "cd /d D:\AI---ML\16\admin_dashboard && py -m http.server 8080"

start "Collector App" cmd /k "cd /d D:\AI---ML\16\collector_web && py -m http.server 8081"

echo All 3 servers starting in separate windows.
echo Backend:   http://localhost:8000
echo Admin:     http://localhost:8080
echo Collector: http://localhost:8081