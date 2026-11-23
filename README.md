# PokeBot

App para Windows que roda 4 contas do PokeIdle numa janela só e automatiza recompra de poções, análise de hunts e troca de hunt.

## O que precisa
- Windows 10 ou 11 (com o WebView2, que já vem no Windows 11)
- [Node.js](https://nodejs.org) 18 ou mais novo

## Instalar
```bash
npm install
npm run build-host
```
O `build-host` gera `host\bin\PokeBot-novo.exe`. O `iniciar.bat` troca esse arquivo pelo `PokeBot.exe` e abre o app.

## Usar
Abra o `iniciar.bat` (ou crie um atalho para ele) e faça login nas contas dentro do app.

## Com o PokeIdle Deck (recomendado)
Dá para usar o [PokeIdle Deck](https://github.com/artbruno35/PokeIdleMulti) como janela das contas (lives, recompra pelo próprio jogo, PvP), com o PokeBot por trás cuidando da hunt.

1. Baixe o PokeBot: **Code → Download ZIP** aqui no GitHub e extraia numa pasta (ex.: `C:\Users\<você>\pokebot`), ou `git clone`.
2. Dê dois cliques no **`instalar.bat`**. Ele confere se o PC tem **Git**, **Node.js 18+** e o **.NET 8 SDK**; se faltar algo, mostra o que é, o link e o comando `winget` para instalar. Instale, feche a janela e abra o `instalar.bat` de novo.
3. Com tudo instalado, ele baixa e compila o deck e cria o atalho **"PokeIdle Deck + PokeBot"** na Área de Trabalho.

Para atualizar, rode o `instalar.bat` de novo (com o deck fechado): se a pasta veio do `git clone` ele usa `git pull`; se veio em ZIP, baixa o ZIP novo e copia por cima, sem mexer nas suas contas, regras, logins e histórico.

Detalhes do deck e do patch: [deck/README.md](deck/README.md).

## Suas contas
Na primeira vez que o app abre, ele cria `config/contas.json` e `config/rules.json` a partir dos modelos `*.example.json`. Troque `conta1` … `conta4` pelos nomes das suas 4 contas nos dois arquivos e abra o app de novo.

## O que fica só no seu PC (não vai para o GitHub)
- `profiles/`: login das contas
- `data/`: logs e histórico
- `config/contas.json` e `config/rules.json`: suas contas e regras
- `config/app.json`: chave do conector MCP (criada sozinha na primeira vez)

Robôs podem ir contra as regras do jogo; o risco é de quem usa.
