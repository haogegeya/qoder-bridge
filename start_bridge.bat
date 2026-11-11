@echo off
cd /d %~dp0
:loop
C:\nvm4w\nodejs\node.exe qoder_bridge.mjs >> run.log 2>&1
echo [%date% %time%] bridge exited, restarting in 10s >> run.log
timeout /t 10 /nobreak >nul
goto loop
