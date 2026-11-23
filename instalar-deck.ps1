# Instala ou atualiza o PokeBot + PokeIdle Deck num comando so:
#   1. atualiza o PokeBot (git pull se veio do git clone; ZIP novo do GitHub se veio em ZIP) e o npm install
#   2. baixa o PokeIdle Deck (artbruno35/PokeIdleMulti) em %USERPROFILE%\PokeIdleMulti, na versao do patch
#   3. aplica deck\pokebot-deck.patch e compila o deck (.NET 8 SDK)
#   4. cria o atalho "PokeIdle Deck + PokeBot" na Area de Trabalho
# Feche o deck antes de rodar. Rodar de novo atualiza. O jeito facil e dar dois cliques no instalar.bat,
# que antes confere se o PC tem Git, Node.js e o .NET 8 SDK e explica como instalar o que faltar.
$ErrorActionPreference = 'Stop'
$raiz = $PSScriptRoot
$deck = Join-Path $env:USERPROFILE 'PokeIdleMulti'
$versaoDeck = '44a5e72'   # a versao do deck em que o patch foi feito (v2026.11.17)
$zipPokebot = 'https://codeload.github.com/Joao-TheCreator/pokebot/zip/refs/heads/main'

# O instalar.bat ja confere tudo isto com explicacoes; aqui fica a mesma conferencia para quem roda o .ps1 direto.
function Precisa($cmd, $onde) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "Falta o $cmd. Instale: $onde (ou use o instalar.bat, que explica)" } }
Precisa git 'winget install --id Git.Git -e (ou https://git-scm.com/download/win)'
Precisa node 'winget install --id OpenJS.NodeJS.LTS -e (ou https://nodejs.org)'
Precisa npm 'reinstale o Node.js (https://nodejs.org)'
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue) -and (Test-Path 'C:\Program Files\dotnet\dotnet.exe')) { $env:Path = 'C:\Program Files\dotnet;' + $env:Path }
Precisa dotnet 'winget install --id Microsoft.DotNet.SDK.8 -e (ou https://dotnet.microsoft.com/download/dotnet/8.0)'
if (-not (dotnet --list-sdks | Where-Object { $_ -match '^8\.' })) { throw 'Falta o .NET 8 SDK (o runtime sozinho nao compila o deck). Instale: winget install --id Microsoft.DotNet.SDK.8 -e (ou https://dotnet.microsoft.com/download/dotnet/8.0)' }
if (Get-Process PokeIdleMulti -ErrorAction SilentlyContinue) { throw 'Feche o PokeIdle Deck antes de atualizar.' }

Write-Host '== 1/4 PokeBot: atualizar e npm install'
if (Test-Path (Join-Path $raiz '.git')) {
  # baixado com git clone: git pull. Se nao der (mudancas locais, sem internet), avisa e segue com o que tem.
  git -C $raiz pull --ff-only
  if ($LASTEXITCODE -ne 0) { Write-Warning 'Nao consegui atualizar com git pull; sigo com a versao que ja esta na pasta.' }
} else {
  # baixado em ZIP (sem .git): baixa o ZIP novo do GitHub e copia por cima, sem tocar no que e seu
  # (config com suas contas e regras, data, profiles com os logins, node_modules).
  try {
    $tmp = Join-Path $env:TEMP ('pokebot-atualizar-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $zip = Join-Path $tmp 'pokebot.zip'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest $zipPokebot -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $tmp -Force
    $novo = Get-ChildItem $tmp -Directory | Select-Object -First 1   # pokebot-main\
    $meus = @('config\app.json', 'config\contas.json', 'config\rules.json')
    Get-ChildItem $novo.FullName -Recurse -File | ForEach-Object {
      $rel = $_.FullName.Substring($novo.FullName.Length + 1)
      if ($meus -contains $rel -or $rel -match '^(data|profiles|node_modules)\\') { return }
      $dest = Join-Path $raiz $rel
      New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
      Copy-Item $_.FullName $dest -Force
    }
    Write-Host '   PokeBot atualizado a partir do ZIP do GitHub.'
  } catch {
    Write-Warning ('Nao consegui baixar a versao nova (' + $_.Exception.Message + '); sigo com a versao que ja esta na pasta.')
  } finally {
    if ($tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
Push-Location $raiz; npm install --no-fund --no-audit; Pop-Location
if ($LASTEXITCODE -ne 0) { throw 'O npm install falhou (veja as mensagens acima).' }

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
