@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
if errorlevel 1 (
  echo Не удалось открыть папку проекта.
  pause
  exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1"
if errorlevel 1 (
  echo.
  echo Сервер не запущен. Причина указана выше.
  echo Журналы: "%~dp0.tmp\local-runtime"
  popd
  pause
  exit /b 1
)
echo.
echo Приложение доступно: http://127.0.0.1:3000
popd
exit /b 0
