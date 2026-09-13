@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Please install Node.js first.
  pause
  exit /b 1
)

if not exist "node_modules\vinext\dist\cli.js" (
  echo LearnFlow dependencies are missing or incomplete. Repairing them now...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency repair failed. Check the network and try again.
    pause
    exit /b 1
  )
)

rem Open the page only after the local server really accepts connections.
start "" powershell -NoProfile -WindowStyle Hidden -Command "$url='http://127.0.0.1:3011'; $deadline=(Get-Date).AddMinutes(3); while((Get-Date) -lt $deadline){ try { $response=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2; if($response.StatusCode -ge 200){ Start-Process $url; exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"
echo LearnFlow is starting. Keep this window open while testing.
call npm run dev -- --port 3011
if errorlevel 1 (
  echo.
  echo LearnFlow failed to start. The error above explains what needs fixing.
  pause
  exit /b 1
)
endlocal
