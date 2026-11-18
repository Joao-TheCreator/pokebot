# Sobe o servidor do PokeBot (porta 8787) escondido, se ainda nao estiver rodando. Usado pelo iniciar-deck.bat.
$raiz = $PSScriptRoot
if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) { exit 0 }
New-Item -ItemType Directory -Force (Join-Path $raiz 'data') | Out-Null
$env:POKEBOT_MODE = 'app'
Start-Process node -ArgumentList 'server.js' -WorkingDirectory $raiz -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $raiz 'data\servidor-deck.log') `
  -RedirectStandardError (Join-Path $raiz 'data\servidor-deck.erro.log')
