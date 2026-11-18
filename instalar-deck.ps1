# Instala ou atualiza o PokeBot + PokeIdle Deck num comando so:
#   1. atualiza este repositorio (git pull) e as dependencias (npm install)
#   2. baixa o PokeIdle Deck (artbruno35/PokeIdleMulti) em %USERPROFILE%\PokeIdleMulti, na versao do patch
#   3. aplica deck\pokebot-deck.patch e compila o deck (.NET 8 SDK)
#   4. cria o atalho "PokeIdle Deck + PokeBot" na Area de Trabalho
# Feche o deck antes de rodar. Rodar de novo atualiza.
$ErrorActionPreference = 'Stop'
$raiz = $PSScriptRoot
$deck = Join-Path $env:USERPROFILE 'PokeIdleMulti'
$versaoDeck = '44a5e72'   # a versao do deck em que o patch foi feito (v2026.11.17)

function Precisa($cmd, $onde) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "Falta o $cmd. Instale: $onde" } }
Precisa git 'https://git-scm.com'
Precisa node 'https://nodejs.org'
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue) -and (Test-Path 'C:\Program Files\dotnet\dotnet.exe')) { $env:Path = 'C:\Program Files\dotnet;' + $env:Path }
Precisa dotnet 'winget install Microsoft.DotNet.SDK.8 (ou https://dotnet.microsoft.com/download/dotnet/8.0)'
if (Get-Process PokeIdleMulti -ErrorAction SilentlyContinue) { throw 'Feche o PokeIdle Deck antes de atualizar.' }

Write-Host '== 1/4 PokeBot: git pull e npm install'
git -C $raiz pull --ff-only
Push-Location $raiz; npm install --no-fund --no-audit; Pop-Location

Write-Host "== 2/4 PokeIdle Deck em $deck"
if (-not (Test-Path (Join-Path $deck '.git'))) { git clone https://github.com/artbruno35/PokeIdleMulti.git $deck }
git -C $deck fetch --quiet origin
# a pasta do deck e so do PokeBot: volta ao codigo original da versao e reaplica o patch
git -C $deck checkout --quiet --force $versaoDeck
git -C $deck clean --quiet -fd PokeIdleMulti

Write-Host '== 3/4 patch do PokeBot e compilacao'
git -C $deck apply (Join-Path $raiz 'deck\pokebot-deck.patch')
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
dotnet publish (Join-Path $deck 'PokeIdleMulti\PokeIdleMulti.csproj') -c Release -r win-x64 --self-contained false -o (Join-Path $deck 'publish') --nologo -v quiet
if ($LASTEXITCODE -ne 0) { throw 'A compilacao do deck falhou (veja as mensagens acima).' }

Write-Host '== 4/4 atalho na Area de Trabalho'
$sh = New-Object -ComObject WScript.Shell
$l = $sh.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'PokeIdle Deck + PokeBot.lnk'))
$l.TargetPath = Join-Path $raiz 'iniciar-deck.bat'
$l.WorkingDirectory = $raiz
$l.IconLocation = (Join-Path $deck 'publish\PokeIdleMulti.exe') + ',0'
$l.WindowStyle = 7
$l.Save()

Write-Host ''
Write-Host 'Pronto. Abra pelo atalho "PokeIdle Deck + PokeBot" na Area de Trabalho.'
Write-Host 'Primeira vez: ponha os nomes das suas 4 contas em config\contas.json (na ordem do deck) e,'
Write-Host 'em config\rules.json, deixe restock.auto = false (quem compra e o carrinho do deck).'
