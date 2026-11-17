# Roadmap

## Feito
- Motor: Chrome normal por conta (perfil próprio, CDP), painel local, regras em `config/rules.json`, aprovações, ponte MCP.
- Compra no Market (poções/revives) por ação `buy`.
- Análise de hunts: copia a ficha do pokémon em campo ("Copiar p/ ChatGPT"), cola em pokeidleguide.io/#hunt e lê o ranking (XP/h, Ouro/h, Shiny/h).

## Próximos
1. Aplicar o ranking: escolher a hunt no jogo a partir do critério (XP, ouro ou shiny) por conta.
2. Analisar mais de um pokémon do time e sugerir quem colocar em campo.
3. Repor itens automaticamente seguindo `rules.json` (75% do ouro, poção até 300, revive até 10).
4. ~~Janela única com as 4 contas~~ feito: PokeBot.exe (WebView2), painel de ferramentas + monitor de RAM/CPU.
5. **Extensão /hunt própria**, sem depender do site (cálculo local com os dados do jogo).
6. Grok como segundo assistente pela mesma ponte MCP.

## Economia (máquina leve com as 4 contas jogando)
Medido no PokeBot (média de 20-25 s, `/metrics`):
- **Antes:** cada conta ~10,5% de CPU (a conta principal ~1 GB de RAM com a cena ligada), PC em ~89% de CPU.
- **Depois:** cada conta ~3-5% de CPU, PC em ~41% de CPU; a conta principal ~640 MB. XP continua subindo nas 4.

O que faz:
- **Animações pausadas fora de foco** (servidor, a cada 5 s): o jogo tem 7-9 brilhos/pulsos CSS infinitos (banners de
  afiliado, VIP, evento) que obrigam a redesenhar 60x/s mesmo com a cena desligada. O motor pausa só os infinitos;
  na conta em foco voltam a tocar. Era o maior gasto de CPU.
- **Modo Economia do jogo** ligado ao tirar a conta do foco (cena desligada; a caça continua no servidor do jogo).
  Só age na troca de foco — se você religar a cena na mão ("Ligar a cena"), fica ligada. Se foi o PokeBot que ligou,
  ele religa a cena quando você abre a conta em foco.
- **MemoryUsageTargetLevel = Low** (WebView2) nas contas fora de foco e nos painéis: descarta caches de imagem/GPU
  (teste equivalente liberou 90-180 MB por conta). Não suspende a página. Precisa reabrir o app.
- Métricas de RAM/CPU a cada 3 s (antes 2 s).
- Desligar tudo: `config/app.json` → `"economia": { "ativa": false }`; só manter o jogo como está: `"modoJogo": false`.

Testado e descartado: `TrySuspendAsync` (congela o jogo). Ler o status em intervalos maiores não compensa (~4 ms por leitura).
Ideia futura (maior ganho de RAM, ~500 MB+): as 4 contas num único navegador WebView2 com perfis separados
(`ProfileName`), dividindo processo de GPU/rede. Exige refazer o login das contas e um mapa de páginas no motor.
