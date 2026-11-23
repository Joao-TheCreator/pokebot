@echo off
setlocal EnableDelayedExpansion
rem Instala ou atualiza o PokeBot + PokeIdle Deck. De dois cliques neste arquivo.
rem 1) confere se o PC tem Git, Node.js (18+) e o .NET 8 SDK; se faltar algo, explica como instalar e para
rem 2) roda o instalar-deck.ps1 (atualiza o PokeBot, baixa e compila o deck, cria o atalho)
title Instalador do PokeBot
cd /d "%~dp0"

echo.
echo  ==============================================
echo    Instalador do PokeBot + PokeIdle Deck
echo  ==============================================
echo.
echo  Conferindo os requisitos...
echo.

set "FALTA=0"

rem ---- Git ----
where git >nul 2>&1
if errorlevel 1 (
  set "FALTA=1"
  echo  [FALTA] Git
  echo          Baixe em https://git-scm.com/download/win
  echo          ou rode no terminal:  winget install --id Git.Git -e
  echo.
) else (
  for /f "tokens=3" %%v in ('git --version') do echo  [ok]    Git %%v
)

rem ---- Node.js 18+ (o npm vem junto) ----
where node >nul 2>&1
if errorlevel 1 (
  set "FALTA=1"
  echo  [FALTA] Node.js
  echo          Baixe a versao LTS em https://nodejs.org
  echo          ou rode no terminal:  winget install --id OpenJS.NodeJS.LTS -e
  echo.
) else (
  for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
  for /f "tokens=1 delims=v." %%m in ("!NODEV!") do set "NODEMAJ=%%m"
  if !NODEMAJ! LSS 18 (
    set "FALTA=1"
    echo  [FALTA] Node.js 18 ou mais novo ^(voce tem !NODEV!^)
    echo          Atualize em https://nodejs.org
    echo          ou rode no terminal:  winget upgrade --id OpenJS.NodeJS.LTS -e
    echo.
  ) else (
    where npm >nul 2>&1
    if errorlevel 1 (
      set "FALTA=1"
      echo  [FALTA] npm ^(vem com o Node.js; reinstale o Node.js em https://nodejs.org^)
      echo.
    ) else (
      echo  [ok]    Node.js !NODEV!
    )
  )
)

rem ---- .NET 8 SDK (o runtime sozinho nao compila o deck) ----
set "DOTNET="
where dotnet >nul 2>&1 && set "DOTNET=dotnet"
if not defined DOTNET if exist "%ProgramFiles%\dotnet\dotnet.exe" set "DOTNET=%ProgramFiles%\dotnet\dotnet.exe"
set "SDK8="
if defined DOTNET (
  for /f "tokens=1" %%v in ('call "!DOTNET!" --list-sdks 2^>nul') do (
    echo %%v| findstr /r /b "8\." >nul && set "SDK8=%%v"
  )
)
if defined SDK8 (
  echo  [ok]    .NET SDK !SDK8!
) else (
  set "FALTA=1"
  if defined DOTNET (
    echo  [FALTA] .NET 8 SDK ^(voce tem o .NET, mas sem o SDK 8; so o runtime nao compila o deck^)
  ) else (
    echo  [FALTA] .NET 8 SDK
  )
  echo          Baixe o "SDK 8.0" ^(nao o Runtime^) em https://dotnet.microsoft.com/download/dotnet/8.0
  echo          ou rode no terminal:  winget install --id Microsoft.DotNet.SDK.8 -e
  echo.
)

echo.
if "%FALTA%"=="1" (
  echo  ----------------------------------------------
  echo   Falta instalar o que esta marcado com [FALTA].
  echo   Depois de instalar, FECHE esta janela e abra
  echo   o instalar.bat de novo ^(o Windows so enxerga
  echo   os programas novos numa janela nova^).
  echo  ----------------------------------------------
  echo.
  pause
  exit /b 1
)

tasklist /fi "imagename eq PokeIdleMulti.exe" 2>nul | find /i "PokeIdleMulti.exe" >nul
if not errorlevel 1 (
  echo  O PokeIdle Deck esta aberto. Feche o deck e rode o instalar.bat de novo.
  echo.
  pause
  exit /b 1
)

echo  Tudo certo. Instalando...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar-deck.ps1"
if errorlevel 1 (
  echo.
  echo  A instalacao parou com erro ^(veja a mensagem acima^).
  echo.
  pause
  exit /b 1
)
echo.
pause
