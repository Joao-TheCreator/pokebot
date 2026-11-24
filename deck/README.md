# PokeBot + PokeIdle Deck

O [PokeIdle Deck](https://github.com/artbruno35/PokeIdleMulti) (do artbruno35, licença MIT) é a janela das contas: 4 contas, lives da Twitch/Kick, recompra pelo próprio jogo, PvP. O PokeBot roda por trás dele com a parte de hunt: analisa no pokeidleguide e troca para a melhor hunt, além do conector MCP.

O `pokebot-deck.patch` muda três coisas no deck:

- **Porta local 9300** (só `127.0.0.1`): o motor do PokeBot se conecta por ela.
- **Marca de cada conta** (`window.__pokebotPerfil = 'conta1'…'conta4'`): o motor sabe qual página é de qual conta. A conta N do deck é a N-ésima do `config/contas.json`.
- **`pokebot.js`**: igual ao `recompra.js` do deck, acompanha o socket do jogo. Guarda a lista de hunts do jogo e a hunt atual, e deixa o motor mandar só três pedidos: `hunt.select`, `centro.desistir` e `centro.curar`. É assim que a troca de hunt acontece sem clicar no Mapa.

Feito sobre a versão `v2026.11.17` (commit `44a5e72`).

## Instalar ou atualizar

Com o deck fechado, dê dois cliques no **`instalar.bat`** na pasta do pokebot (baixada em ZIP ou com `git clone`).

Primeiro ele confere os requisitos e, se faltar algum, diz qual e como instalar:

| Precisa | Onde baixar | Pelo terminal |
|---|---|---|
| Git | https://git-scm.com/download/win | `winget install --id Git.Git -e` |
| Node.js 18 ou mais novo | https://nodejs.org (LTS) | `winget install --id OpenJS.NodeJS.LTS -e` |
| .NET 8 **SDK** (não só o Runtime) | https://dotnet.microsoft.com/download/dotnet/8.0 | `winget install --id Microsoft.DotNet.SDK.8 -e` |

Depois de instalar o que faltava, feche a janela e abra o `instalar.bat` de novo (o Windows só enxerga programas novos numa janela nova).

Com tudo certo, ele roda o `instalar-deck.ps1`, que:

1. atualiza o PokeBot: `git pull` se a pasta veio do `git clone`; se veio em ZIP, baixa o ZIP novo do GitHub e copia por cima, sem tocar em `config\contas.json`, `config\rules.json`, `config\app.json`, `data\`, `profiles\` e `node_modules\`. Se não conseguir atualizar (sem internet, mudanças locais), avisa e segue com a versão que já está na pasta;
2. baixa o deck na versão do patch, aplica o patch e compila;
3. cria o atalho "PokeIdle Deck + PokeBot" na Área de Trabalho.

Quem preferir o terminal pode rodar o script direto: `powershell -ExecutionPolicy Bypass -File instalar-deck.ps1`.

## Montar à mão

Precisa do [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) e do Node.js.

```bash
git clone https://github.com/artbruno35/PokeIdleMulti %USERPROFILE%\PokeIdleMulti
cd %USERPROFILE%\PokeIdleMulti
git checkout 44a5e72
git apply <pasta do pokebot>\deck\pokebot-deck.patch
cd PokeIdleMulti
dotnet publish PokeIdleMulti.csproj -c Release -r win-x64 --self-contained false -o ..\publish
```

O exe fica em `%USERPROFILE%\PokeIdleMulti\publish\PokeIdleMulti.exe`, que é onde o `iniciar-deck.bat` procura.

## Usar

1. Abra o `iniciar-deck.bat` (ou um atalho para ele). Ele abre o deck e sobe o servidor do PokeBot escondido (porta 8787).
2. Entre nas contas no deck, na mesma ordem do `config/contas.json`.
3. No `config/rules.json`, deixe `restock.auto` em `false` (já vem assim): quem compra é o carrinho 🛒 do deck.
4. Use o **Modo Economia** do jogo, não o ⚡ ULTRA: com o ULTRA o PokeBot ainda não consegue ler o nível e a hunt da tela.
5. O motor só se liga às páginas do jogo: a Kick e a Twitch ficam livres para logar com o PokeBot ligado.
5. As aprovações de troca de hunt ficam em `http://127.0.0.1:8787`.

### O servidor precisa estar ligado

A recompra do deck às vezes desliga sozinha na página do jogo; quem liga de novo (a cada minuto) é o servidor do PokeBot, que também faz a hunt automática. Abrir o deck direto pelo `PokeIdleMulti.exe` (um ícone fixado na barra de tarefas, por exemplo) **não** liga o servidor: as contas ficam sem comprar poção e revive e param no Centro. Para não depender de como o deck é aberto, deixe o servidor ligar com o Windows: um atalho na pasta de inicialização (`Win+R` → `shell:startup`) para

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<pasta do pokebot>\iniciar-servidor.ps1"
```

Rodar de novo não abre um segundo servidor. Para desligar isso, apague o atalho.

Não abra o PokeBot.exe e o deck ao mesmo tempo: os dois usam a porta 9300, e a mesma conta aberta em dois lugares derruba uma delas.
