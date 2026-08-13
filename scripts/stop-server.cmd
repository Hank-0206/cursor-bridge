@echo off
rem Stop the cursor-bridge daemon loop and the node server
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'run-server\.cmd') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'cursor-bridge') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo cursor-bridge stopped.
