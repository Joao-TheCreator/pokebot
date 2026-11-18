# PokeBot + PokeIdle Deck

O [PokeIdle Deck](https://github.com/artbruno35/PokeIdleMulti) (do artbruno35, licença MIT) é a janela das contas: 4 contas, lives da Twitch/Kick, recompra pelo próprio jogo, PvP. O PokeBot roda por trás dele com a parte de hunt: analisa no pokeidleguide e troca para a melhor hunt, além do conector MCP.

O `pokebot-deck.patch` muda três coisas no deck:

- **Porta local 9300** (só `127.0.0.1`): o motor do PokeBot se conecta por ela.
- **Marca de cada conta** (`window.__pokebotPerfil = 'conta1'…'conta4'`): o motor sabe qual página é de qual conta. A conta N do deck é a N-ésima do `config/contas.json`.
- **`pokebot.js`**: igual ao `recompra.js` do deck, acompanha o socket do jogo. Guarda a lista de hunts do jogo e a hunt atual, e deixa o motor mandar só três pedidos: `hunt.select`, `centro.desistir` e `centro.curar`. É assim que a troca de hunt acontece sem clicar no Mapa.

Feito sobre a versão `v2026.11.17` (commit `44a5e72`).

## Instalar ou atualizar num comando

Com o deck fechado, dentro da pasta do pokebot:

```bash
powershell -ExecutionPolicy Bypass -File instalar-deck.ps1
```

Ele atualiza o PokeBot, baixa o deck na versão do patch, aplica o patch, compila e cria o atalho
"PokeIdle Deck + PokeBot" na Área de Trabalho. Precisa do Git, do Node.js e do
[.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) (`winget install Microsoft.DotNet.SDK.8`).

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

Não abra o PokeBot.exe e o deck ao mesmo tempo: os dois usam a porta 9300, e a mesma conta aberta em dois lugares derruba uma delas.
