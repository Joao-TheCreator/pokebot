@echo off
rem Abre o PokeIdle Deck (as contas, lives e recompra) e, por tras, o servidor do PokeBot (hunt automatica e MCP).
rem O deck fica em %USERPROFILE%\PokeIdleMulti\publish (compilado do github.com/artbruno35/PokeIdleMulti).
set "DECK=%USERPROFILE%\PokeIdleMulti\publish\PokeIdleMulti.exe"
if not exist "%DECK%" (
  echo Nao achei o deck em %DECK%
  pause
  exit /b 1
)
start "" "%DECK%"
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0iniciar-servidor.ps1"
