@echo off
chcp 65001 > nul
rem cursor-bridge daemon: auto-restart loop, logs to data\server.log
rem %~dp0 = this script's folder (scripts\); project root is its parent
cd /d "%~dp0.."
set "NODE_NO_WARNINGS=1"

rem exit if another instance already listens on 8318
netstat -ano | findstr /r /c:":8318 .*LISTENING" > nul && exit /b 0

if not exist data mkdir data
:loop
if exist data\server.log for %%A in (data\server.log) do if %%~zA gtr 10485760 move /y data\server.log data\server.log.1 > nul
echo [%date% %time%] starting cursor-bridge >> data\server.log
node "node_modules\tsx\dist\cli.mjs" "src\server.ts" >> data\server.log 2>&1
echo [%date% %time%] exited with code %errorlevel%, restarting in 3s >> data\server.log
timeout /t 3 /nobreak > nul
goto loop
