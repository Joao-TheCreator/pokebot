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

## Suas contas
Na primeira vez que o app abre, ele cria `config/contas.json` e `config/rules.json` a partir dos modelos `*.example.json`. Troque `conta1` … `conta4` pelos nomes das suas 4 contas nos dois arquivos e abra o app de novo.

## O que fica só no seu PC (não vai para o GitHub)
- `profiles/`: login das contas
- `data/`: logs e histórico
- `config/contas.json` e `config/rules.json`: suas contas e regras
- `config/app.json`: chave do conector MCP (criada sozinha na primeira vez)

Robôs podem ir contra as regras do jogo; o risco é de quem usa.
