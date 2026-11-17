// Ferramentas MCP do PokeBot, usadas por dois conectores:
//  - mcp/index.js (stdio, para Claude Code / Grok CLI): todas as ferramentas
//  - server.js /mcp (HTTP local com chave, para outros apps como o Grok Bot): so as "seguras"
//    (sem rodar JavaScript, clicar livre ou abrir janelas)
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const fs = require('fs');
const path = require('path');
// nomes das contas: config/contas.json (so neste PC) ou o modelo config/contas.example.json
function contas() {
  for (const f of ['contas.json', 'contas.example.json']) {
    try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', f), 'utf8')).contas; if (Array.isArray(c) && c.length) return c; } catch {}
  }
  return ['conta1', 'conta2', 'conta3', 'conta4'];
}

const SEGURAS = new Set(['visao_geral', 'status', 'texto_tela', 'estoque', 'metricas', 'hunts', 'regras',
  'analisar_hunts', 'analisar_todas', 'ir_melhor_hunt', 'cacar', 'recomprar']);

function criarServidor(call, { completo = true } = {}) {
  const s = new McpServer({ name: 'pokebot', version: '0.2.0' });
  const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] });
  const acc = z.string().describe('nome da conta: ' + contas().join(', '));
  const limpa = (a) => Object.fromEntries(Object.entries(a).filter(([, v]) => v != null));
  const tool = (nome, desc, schema, fn) => { if (completo || SEGURAS.has(nome)) s.tool(nome, desc, schema, fn); };

  tool('visao_geral', 'Status das 4 contas (nivel, ouro, XP/h, lucro/h, hunt), aprovacoes pendentes e log', {}, async () => text(await call('overview')));
  tool('status', 'Status de uma conta (nivel, ouro, xp, hunt, XP/h)', { acc }, async (a) => text(await call('status', a)));
  tool('texto_tela', 'Texto visivel do jogo de uma conta', { acc }, async (a) => text(await call('text', a)));
  tool('estoque', 'Pocoes, revives e bolas da conta (painel Automacoes)', { acc }, async (a) => text(await call('estoque', a)));
  tool('metricas', 'RAM/CPU do PC, de cada conta e do app', {}, async () => text(await call('metrics')));
  tool('hunts', 'Ganho real medido por hunt (XP/h e ouro/h)', {}, async () => text(await call('hunts')));
  tool('regras', 'Regras atuais (rules.json): limites de gasto, recompra, risco de hunt', {}, async () => text(await call('rules')));
  tool('analisar_hunts', 'Analisa o pokemon em campo da conta no pokeidleguide.io e devolve o ranking por XP/h, Ouro/h e Shiny/h', { acc }, async (a) => text(await call('rank', a)));
  tool('analisar_todas', 'Analisa as 4 contas e devolve a melhor hunt segura de cada uma', {}, async () => text(await call('rankall')));
  tool('ir_melhor_hunt', 'Cura se precisar, poe o principal em campo, analisa e vai para a melhor hunt segura (acc ou "todas"). Se o jogo recusar por combate, desiste do combate (perde 10% do XP do nivel) so se a nova render >= rules.hunt.ganhoMinForcarPct',
    { acc: z.string().describe('conta ou "todas"'), crit: z.enum(['XP/h', 'Ouro/h', 'Shiny/h']).optional() },
    async (a) => text(await call('irmelhor', { acc: a.acc, crit: a.crit || 'XP/h' })));
  tool('cacar', 'Vai para uma hunt especifica pelo Mapa. forcar=true desiste do combate se o jogo recusar (perde 10% do XP do nivel)',
    { acc, nome: z.string().describe('pokemon da hunt, ex.: Charmander'), nivel: z.number(), forcar: z.boolean().optional() },
    async (a) => text(await call('cacar', { acc: a.acc, nome: a.nome, nivel: a.nivel, forcar: a.forcar ? '1' : '0' })));
  tool('recomprar', 'Recompra pelo rules.json (no maximo 75% do ouro: pocao, revive, bola). dry=true so mostra o plano sem comprar',
    { acc, dry: z.boolean().optional() }, async (a) => text(await call('recomprar', { acc: a.acc, ...(a.dry ? { dry: '1' } : {}) })));

  // so no conector completo (local, Claude): controle fino
  tool('abrir', 'Conecta o motor a uma conta aberta no app', { acc }, async (a) => text(await call('open', a)));
  tool('abrir_todas', 'Conecta o motor as 4 contas', {}, async () => text(await call('openall')));
  tool('print', 'Screenshot; devolve o caminho do arquivo', { acc }, async (a) => text(await call('shot', a)));
  tool('aba', 'Abre aba do jogo', { acc, name: z.enum(['equipe', 'mochila', 'auto', 'chat', 'menu']) }, async (a) => text(await call('tab', a)));
  tool('clicar', 'Clica no texto visivel exato, ou em x,y', { acc, text: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
    async (a) => text(await call('click', limpa(a))));
  tool('rolar', 'Rola paineis rolaveis', { acc, dy: z.number().optional() }, async (a) => text(await call('scroll', limpa(a))));
  tool('js', 'Roda JavaScript na pagina (leitura/depuracao)', { acc, code: z.string() }, async (a) => text(await call('eval', a)));
  tool('propor', 'Propoe acao que gasta ouro/vende: o usuario aprova no painel. call = tab|click|eval|key|type; args = JSON',
    { acc, desc: z.string(), call: z.string(), args: z.string().optional() }, async (a) => text(await call('propose', a)));
  return s;
}

module.exports = { criarServidor, SEGURAS };
