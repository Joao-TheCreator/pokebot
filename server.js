// PokeBot: painel + API local (127.0.0.1:8787). Nada sai do PC.
const http = require('http');
const fs = require('fs');
const path = require('path');
// primeira vez neste PC: cria as configs locais a partir dos modelos (config/*.example.json)
for (const f of ['contas', 'rules']) {
  const local = path.join(__dirname, 'config', f + '.json'), modelo = path.join(__dirname, 'config', f + '.example.json');
  if (!fs.existsSync(local) && fs.existsSync(modelo)) fs.copyFileSync(modelo, local);
}
const { actions, ctxs, PORTS, CONTAS } = require('./engine/engine');

const PORT = 8787;
const RULES = path.join(__dirname, 'config', 'rules.json');
const HUNTS = path.join(__dirname, 'data', 'hunts.json');
const LOGF = path.join(__dirname, 'data', 'log.jsonl');

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
// chave "Ficar na melhor hunt e repor o estoque" de cada conta (painel Automacao); sem config = ligada
const autoLigada = (acc) => ((readJson(path.join(__dirname, 'config', 'rules.json'), {}).accounts || {})[acc]?.auto?.ativo) !== false;
const ITENS = ['Poke Ball', 'Great Ball', 'Super Ball', 'Ultra Ball', 'Beast Ball', 'Small Potion', 'Great Potion', 'Ultra Potion',
  'Hyper Potion', 'Ultimate Potion', 'Golden Potion', 'Revive', 'Max Revive'];
// automacao de uma conta: a salva no painel, ou a equivalente das regras antigas (restock/potion/revive/ultraBall)
function automacao(acc, R = readJson(path.join(__dirname, 'config', 'rules.json'), {})) {
  const conta = (R.accounts || {})[acc] || {}, rs = R.restock || {};
  if (conta.auto && conta.auto.itens) return { ativo: conta.auto.ativo !== false, guardarOuro: +conta.auto.guardarOuro || 0, itens: conta.auto.itens, salva: true };
  const itens = Object.fromEntries(ITENS.map(i => [i, { abaixo: 0, ate: 0 }]));
  const pocao = conta.potion || (R.potion || {}).type || 'Great Potion';
  itens[pocao] = { abaixo: rs.potionMin ?? 100, ate: conta.potionStock || (R.potion || {}).targetStock || 300 };
  itens['Revive'] = { abaixo: rs.reviveMin ?? 5, ate: (R.revive || {}).targetStock || 10 };
  const min = (R.ultraBall || {}).minAfterBuy ?? 150;
  itens[rs.ball || 'Ultra Ball'] = { abaixo: min, ate: min * 2 };
  return { ativo: conta.auto?.ativo !== false, guardarOuro: rs.reservaOuro || 0, itens, salva: false };
}
const rules = () => readJson(RULES, {});
const recent = [];
const log = (acc, what) => {
  const e = { t: new Date().toISOString(), acc, what };
  fs.appendFile(LOGF, JSON.stringify(e) + '\n', () => {});
  recent.push(e); if (recent.length > 200) recent.shift();
};

// ---- rastreio de XP/h e ouro/h por hunt (dados proprios, medidos no jogo) ----
const last = {};
const statusCache = {};
const RANKS = path.join(__dirname, 'data', 'ranks.json');
const ranks = readJson(RANKS, {});
const hunts = readJson(HUNTS, {}); // hunt -> {sec, xp, gold}
// ---- economia de maquina: conta fora de foco = animacoes pausadas + Modo Economia do jogo ----
// config/app.json: "economia": { "ativa": true, "modoJogo": true }  (ativa=false desliga tudo)
const APPCFG = path.join(__dirname, 'config', 'app.json');
const ecoFoco = {}; // acc -> ultimo estado aplicado: 'fora' | 'foco'
async function economia(acc, idx) {
  const cfg = { ativa: true, modoJogo: true, ...(readJson(APPCFG, {}).economia || {}) };
  const foco = metrics && typeof metrics.foco === 'number' ? metrics.foco : -1;
  const estado = !cfg.ativa || foco === idx ? 'foco' : 'fora';
  const troca = ecoFoco[acc] !== estado;
  if (estado === 'foco' && !troca) return null; // em foco: nada a fazer depois de restaurar uma vez
  const r = await actions.economia({ acc, on: estado === 'fora', jogo: troca && cfg.modoJogo });
  ecoFoco[acc] = estado;
  if (r && r.acao) log(acc, 'economia: ' + r.acao);
  return r;
}

async function tick() {
  const accs = Object.keys(PORTS);
  for (const acc of accs) { // conecta sozinho em cada conta aberta no app
    try {
      const s = await actions.status({ acc });
      let eco = null;
      // economia so com o PokeBot.exe (ele manda as metricas e o foco); no PokeIdle Deck quem cuida e o ULTRA do deck
      if (metrics) { try { eco = await economia(acc, accs.indexOf(acc)); } catch { delete ecoFoco[acc]; } }
      statusCache[acc] = { ...s, economia: eco ? eco.eco : (statusCache[acc] || {}).economia ?? null, at: Date.now() };
      const p = last[acc];
      if (p && s.loggedIn && p.loggedIn && s.hunt) {
        const dt = (Date.now() - p.at) / 1000;
        const dxp = s.level === p.level ? s.xp - p.xp : (s.level > p.level ? p.xpMax - p.xp + s.xp : 0);
        const dg = Math.max(0, s.gold - p.gold); // gasto nao conta como ganho
        if (dt < 120 && dxp >= 0) {
          const h = (hunts[s.hunt] ||= { sec: 0, xp: 0, gold: 0 });
          h.sec += dt; h.xp += dxp; h.gold += dg;
          // a mesma medida separada por tipagem do dia: a hunt rende diferente em cada uma
          if (s.tipoDia) { const t = ((h.porTipo ||= {})[s.tipoDia] ||= { sec: 0, xp: 0, gold: 0 }); t.sec += dt; t.xp += dxp; t.gold += dg; }
        }
      }
      last[acc] = { ...s, at: Date.now() };
    } catch (e) { statusCache[acc] = { error: String(e.message || e), at: Date.now() }; }
  }
  fs.writeFile(HUNTS, JSON.stringify(hunts), () => {});
  vigiarDiaEEventos();
}

// ---- Tipagem do dia e eventos 🎉: quando mudam, reanalisa as 4 contas na hora (sem esperar o intervaloMin) ----
// Todo evento visto vai para data/eventos.jsonl (para aprender o formato e, depois, somar o bonus na comparacao).
const EVENTOS = path.join(__dirname, 'data', 'eventos.jsonl');
let diaVisto, eventosVistos;
const candidato = { sig: '', n: 0 };
function vigiarDiaEEventos() {
  const logadas = Object.keys(PORTS).filter(a => statusCache[a]?.loggedIn);
  if (!logadas.length) return;
  const dia = logadas.map(a => statusCache[a].tipoDia).find(Boolean) || null;
  const evs = [...new Set(logadas.map(a => statusCache[a].event).filter(Boolean))].sort();
  const sigEv = JSON.stringify(evs);
  if (diaVisto === undefined) { diaVisto = dia; eventosVistos = sigEv; return; } // ao subir: so guarda (o huntLoop ja analisa)
  // so vale a mudanca que se repete em 3 leituras seguidas (~15 s): uma linha que pisca na tela nao dispara nada
  const sig = (dia || diaVisto) + '|' + sigEv;
  if (sig !== candidato.sig) { candidato.sig = sig; candidato.n = 1; return; }
  if (++candidato.n < 3) return;
  const mudou = [];
  if (dia && dia !== diaVisto) { mudou.push(`tipagem do dia: ${diaVisto || '?'} → ${dia}`); diaVisto = dia; }
  if (sigEv !== eventosVistos) {
    const antes = JSON.parse(eventosVistos || '[]');
    for (const e of evs.filter(e => !antes.includes(e))) { mudou.push('evento começou: ' + e); fs.appendFile(EVENTOS, JSON.stringify({ t: new Date().toISOString(), inicio: e, dia }) + '\n', () => {}); }
    for (const e of antes.filter(e => !evs.includes(e))) { mudou.push('evento acabou: ' + e); fs.appendFile(EVENTOS, JSON.stringify({ t: new Date().toISOString(), fim: e, dia }) + '\n', () => {}); }
    eventosVistos = sigEv;
  }
  if (!mudou.length) return;
  log('-', mudou.join(' · ') + ' — reanalisando as contas');
  avisar('-', 'PokeBot: o jogo mudou', mudou.join(' · ') + ' — reanalisando as hunts');
  for (const a of Object.keys(PORTS)) ultimaAnalise[a] = 0; // o huntLoop (a cada minuto) analisa todas de novo
}
let metrics = null;
let ticking = false;
setInterval(async () => { if (ticking) return; ticking = true; try { await tick(); } finally { ticking = false; } }, 5000);

// ---- Recompra automatica: a cada restock.intervaloMin, cada conta logada compra o que faltar (rules.json) ----
// A conta que voce esta olhando (em foco) so e mexida se acabou poção, revive ou bola — para nao abrir o Market na sua cara.
const ultimoRestock = {};
let restocking = false;
async function restockLoop() {
  const R = rules().restock || {};
  if (!R.auto || restocking) return;
  restocking = true;
  try {
    for (const [i, acc] of Object.keys(PORTS).entries()) {
      if (!statusCache[acc]?.loggedIn || !autoLigada(acc)) continue; // conta com a automacao desligada no painel: nao mexe
      if (Date.now() - (ultimoRestock[acc] || 0) < (R.intervaloMin || 10) * 60000) continue;
      ultimoRestock[acc] = Date.now();
      try {
        if (metrics && metrics.foco === i) {
          const { itens, lancaBola } = await actions.estoque({ acc });
          const zerou = !Object.entries(itens).some(([k, v]) => /Potion/.test(k) && v > 0) || (lancaBola && !(itens[R.ball || 'Ultra Ball'] > 0));
          if (!zerou) continue;
        }
        const r = await actions.restock({ acc });
        const feitas = r.compras.filter(c => c.resultado);
        if (feitas.length) log(acc, 'recompra: ' + feitas.map(c => `${c.qtd} ${c.item}`).join(', ') + ` (${(r.ouroAntes - r.ouroDepois).toLocaleString('pt-BR')} ouro)`);
      } catch (e) { log(acc, 'recompra falhou: ' + (e.message || e)); }
    }
  } finally { restocking = false; }
}
setInterval(restockLoop, 60000);
setTimeout(restockLoop, 20000);

// ---- Consumo de estoque: le o estoque de cada conta a cada 2 min e guarda 3 h de amostras ----
// Taxa = soma das quedas / tempo (compras, que fazem o numero subir, nao contam). Usado para "acaba em ~X h".
const estoqueHist = {}; // acc -> [{t, itens}]
async function estoqueLoop() {
  for (const acc of Object.keys(PORTS)) {
    if (!statusCache[acc]?.loggedIn) continue;
    try {
      const { itens } = await actions.estoque({ acc });
      const h = (estoqueHist[acc] ||= []);
      h.push({ t: Date.now(), itens });
      while (h.length && Date.now() - h[0].t > 3 * 3600000) h.shift();
    } catch {}
  }
}
setInterval(estoqueLoop, 120000);
setTimeout(estoqueLoop, 15000);
function consumo(acc) {
  const h = estoqueHist[acc] || [];
  const R = rules();
  const out = {};
  if (h.length < 2) return { amostras: h.length, itens: out };
  const horas = (h[h.length - 1].t - h[0].t) / 3600000;
  for (const item of Object.keys(h[h.length - 1].itens)) {
    let gasto = 0;
    for (let i = 1; i < h.length; i++) gasto += Math.max(0, (h[i - 1].itens[item] || 0) - (h[i].itens[item] || 0));
    const tem = h[h.length - 1].itens[item] || 0;
    const porHora = horas > 0 ? gasto / horas : 0;
    out[item] = { tem, porHora: Math.round(porHora * 10) / 10, horasRestantes: porHora > 0 ? Math.round(tem / porHora * 10) / 10 : null };
  }
  const acc_ = R.accounts?.[acc] || {};
  return { amostras: h.length, minutos: Math.round(horas * 60), itens: out,
    minimos: { potion: R.restock?.potionMin ?? 100, revive: R.restock?.reviveMin ?? 5, ball: R.ultraBall?.minAfterBuy ?? 150 },
    metas: { potion: acc_.potionStock ?? R.potion?.targetStock ?? 300, potionItem: acc_.potion ?? R.potion?.type ?? 'Great Potion', revive: R.revive?.targetStock ?? 10, ball: R.restock?.ball ?? 'Ultra Ball' } };
}

// ---- Vigia da recompra do PokeIdle Deck ----
// Visto em 19/11/2026: o deck.json com a recompra ligada e o script dela na pagina desligado (as contas ficaram sem
// pocao). A cada minuto: se o deck diz ligada e a pagina esta desligada, manda de novo a config do deck.json, igual o
// deck faz ao carregar a pagina.
const DECK_JSON = path.join(process.env.LOCALAPPDATA || '', 'PokeIdleMulti', 'deck.json');
const camel = (v) => (Array.isArray(v) ? v.map(camel) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k[0].toLowerCase() + k.slice(1), camel(x)])) : v);
async function vigiarRecompraDeck() {
  const deck = readJson(DECK_JSON, null);
  if (!deck || !Array.isArray(deck.Restock)) return; // sem o deck (PokeBot.exe): nada a fazer
  for (const [i, acc] of Object.keys(PORTS).entries()) {
    const cfg = deck.Restock[i];
    if (!cfg || !cfg.On || (deck.Off || [])[i] || !statusCache[acc]?.loggedIn) continue;
    try {
      const on = await actions.eval({ acc, code: 'window.__deckRecompra ? window.__deckRecompra.summary().on : null' });
      if (on !== false) continue;
      await actions.eval({ acc, code: `window.__deckRecompra.configure(${JSON.stringify(camel(cfg))})` });
      log(acc, 'recompra do deck estava desligada na pagina: liguei de novo com a config do deck');
    } catch {}
  }
}
setInterval(vigiarRecompraDeck, 60000);
setTimeout(vigiarRecompraDeck, 30000);

// ---- Avisos para o PokeBot.exe (balao do Windows): o host busca a fila a cada POST de metrics ----
const avisos = [];
const avisar = (acc, titulo, texto) => { avisos.push({ acc, idx: Object.keys(PORTS).indexOf(acc), titulo, texto, t: Date.now() }); if (avisos.length > 20) avisos.shift(); };

// ---- Hunt automatica: a cada rules.hunt.auto.intervaloMin analisa cada conta logada ----
// Se a melhor hunt render pelo menos ganhoMinPct a mais: conta em modo livre troca sozinha e avisa;
// as outras ganham um pedido "Trocar?" no painel (Aprovar/Recusar) e um aviso do Windows.
// A conta que voce esta olhando fica para a proxima rodada (a analise abre a ficha do pokemon no jogo).
const ultimaAnalise = {};
let analisando = false;
// ---- ganho medido x estimativa do pokeidleguide ----
// O guia estima menos que o jogo mede (VIP, guild, boosts): a escala vem das hunts que estao no ranking E foram
// medidas por pelo menos MIN_H horas (data/hunts.json). Sem medida da hunt atual, ou sem escala, devolve null
// (a analise segue como antes).
const MIN_H = 0.5;
const valorNum = (s) => { // "12 mi" | "609,4 mil" | "5.700" -> numero
  const m = String(s || '').match(/([\d.,]+)\s*(mi|mil)?/); if (!m) return null;
  const n = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
  return n * (m[2] === 'mi' ? 1e6 : m[2] === 'mil' ? 1e3 : 1);
};
const chaveHunt = (pokemon, nivel) => `${pokemon} · nível ${nivel}`;
// Com a tipagem do dia, usa a medida feita naquela tipagem (se tiver MIN_H horas); senao, a media de todos os dias.
function medidoPorHora(chave, crit, tipo) {
  const h0 = hunts[chave]; if (!h0) return null;
  const pt = tipo && h0.porTipo && h0.porTipo[tipo];
  const h = pt && pt.sec >= MIN_H * 3600 ? pt : h0;
  if (h.sec < MIN_H * 3600) return null;
  const v = crit === 'Ouro/h' ? h.gold : h.xp;
  return v / (h.sec / 3600);
}
function escalaGuia(acc, crit) {
  const amostras = (contas) => {
    const out = [];
    for (const a of contas) for (const row of (ranks[a]?.ranking?.[crit] || [])) {
      const m = String(row[1] || '').match(/^(.*?) Nv (\d+)/); if (!m) continue;
      const real = medidoPorHora(chaveHunt(m[1], m[2]), crit, ranks[a]?.tipoDoDia), guia = valorNum(row[2]);
      if (real && guia) out.push(real / guia);
    }
    return out.sort((x, y) => x - y);
  };
  let s = amostras([acc]); if (!s.length) s = amostras(Object.keys(ranks));
  return s.length ? s[Math.floor(s.length / 2)] : null; // mediana
}
function compararMedido(acc, r, crit) {
  if (crit !== 'XP/h' && crit !== 'Ouro/h') return null;
  const tipo = r.analise?.tipoDoDia || null; // compara as duas hunts na mesma tipagem do dia, quando houver medida
  const atualReal = medidoPorHora(r.atual, crit, tipo); if (!atualReal) return null;
  const melhor = r.analise?.recomendacao?.[crit]?.melhor; if (!melhor) return null;
  let alvoReal = medidoPorHora(chaveHunt(melhor.pokemon, melhor.nivel), crit, tipo), como = 'medido';
  if (!alvoReal) {
    const k = escalaGuia(acc, crit), g = melhor.valorNum ?? valorNum(melhor.valor);
    if (!k || !g) return null;
    alvoReal = g * k; como = `estimado ×${k.toFixed(2)}`;
  }
  const ganhoPct = Math.round((alvoReal / atualReal - 1) * 1000) / 10;
  const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' mi' : Math.round(n / 1e3) + ' mil';
  return { ganhoPct, texto: `${ganhoPct >= 0 ? '+' : ''}${ganhoPct}% ${crit} (atual ${fmt(atualReal)} medido; nova ${fmt(alvoReal)} ${como})` };
}

const PARADA_MIN = 5;
const ultimaParada = {};
async function huntLoop() {
  const H = { ativo: false, intervaloMin: 30, crit: 'XP/h', ganhoMinPct: 10, ...((rules().hunt || {}).auto || {}) };
  if (!H.ativo || analisando) return;
  analisando = true;
  try {
    for (const [i, acc] of Object.keys(PORTS).entries()) {
      if (!statusCache[acc]?.loggedIn || !autoLigada(acc)) continue; // conta com a automacao desligada no painel: nao mexe
      // Hunt fixa (rules.json accounts.<conta>.huntFixa = { nome, nivel }): a conta fica nela, sem analise nem troca
      // (ex.: farm de Fragmento de Chave na Outland). Parada, volta para essa mesma hunt, nao para a "melhor".
      const fixa = rules().accounts?.[acc]?.huntFixa;
      if (fixa && fixa.nome && fixa.nivel) {
        if (!statusCache[acc].hunt && Date.now() - (ultimaParada[acc] || 0) >= PARADA_MIN * 60000) {
          ultimaParada[acc] = Date.now();
          await new Promise(res => setTimeout(res, 15000));
          const s = await actions.status({ acc }).catch(() => null);
          if (s && s.loggedIn && !s.hunt) {
            try {
              await run('cacar', { acc, nome: fixa.nome, nivel: fixa.nivel, forcar: true }, acc);
              log(acc, `hunt fixa: estava parada, voltou para ${fixa.nome} Nv ${fixa.nivel}`);
              avisar(acc, `${acc}: estava parada`, `voltou para a hunt fixa ${fixa.nome} Nv ${fixa.nivel}`);
            } catch (e) { log(acc, 'hunt fixa: nao consegui voltar: ' + (e.message || e)); }
          }
        }
        continue;
      }
      // Conta parada (logada e sem hunt) nao rende nada: vai direto para a melhor hunt, em qualquer conta (nao e troca,
      // e comecar). O irMelhor cura, poe o principal em campo e so entao analisa (sem o "Geodude Nv 1" da analise torta).
      // Tenta de novo a cada PARADA_MIN, sem esperar o intervaloMin.
      if (!statusCache[acc].hunt && Date.now() - (ultimaParada[acc] || 0) >= PARADA_MIN * 60000) {
        ultimaParada[acc] = Date.now();
        await new Promise(res => setTimeout(res, 15000)); // parada de passagem (troca de hunt, desmaio): confere de novo
        const s = await actions.status({ acc }).catch(() => null);
        if (s && s.loggedIn && !s.hunt) {
          try {
            const out = await routes.irmelhor({ acc, crit: H.crit });
            ultimaAnalise[acc] = Date.now();
            avisar(acc, `${acc}: estava parada`, `${out[acc]}`);
          } catch (e) { log(acc, 'conta parada, nao consegui por na hunt: ' + (e.message || e)); }
          continue;
        }
      }
      if (Date.now() - (ultimaAnalise[acc] || 0) < H.intervaloMin * 60000) continue;
      if (metrics && metrics.foco === i && metrics.visiveis && metrics.visiveis.filter(Number).length === 1) continue; // so ela na tela: espera
      ultimaAnalise[acc] = Date.now();
      try {
        const r = await actions.avaliarHunt({ acc, crit: H.crit });
        ranks[acc] = { ...r.analise, at: Date.now() }; fs.writeFile(RANKS, JSON.stringify(ranks), () => {});
        if (r.jaEsta || (r.ganhoPct != null && r.ganhoPct < H.ganhoMinPct)) continue;
        // sem hunt atual lida (conta no Centro/parada) a analise sai torta (ex.: "Geodude Nv 1"): espera a proxima rodada
        if (!r.atual) { ultimaAnalise[acc] = Date.now() - (H.intervaloMin - 5) * 60000; continue; }
        let ganho = r.ganhoPct != null ? `+${r.ganhoPct}% ${H.crit}` : 'hunt atual fora do ranking';
        if (r.ganhoPct == null) { // hunt atual fora do top 15: compara com o que ela rende de verdade (medido)
          const c = compararMedido(acc, r, H.crit);
          if (c) {
            if (c.ganhoPct < H.ganhoMinPct) { log(acc, `hunt: fica em ${r.atual} — ${c.texto}`); continue; }
            ganho = c.texto;
          }
        }
        if (rules().accounts?.[acc]?.freeMode) {
          const out = await routes.irmelhor({ acc, crit: H.crit });
          avisar(acc, `${acc}: troca de hunt`, `${out[acc]} (${ganho})`);
        } else {
          for (const p of Object.values(pending)) if (p.acc === acc && p.call === 'irMelhor') delete pending[p.id];
          const desc = `Trocar de ${r.atual || '?'} para ${r.alvo}? ${ganho}`;
          await routes.propose({ acc, desc, call: 'irMelhor', args: JSON.stringify({ crit: H.crit }) });
          avisar(acc, `${acc}: hunt melhor`, desc + ' — aprove no painel');
        }
      } catch (e) { log(acc, 'analise de hunt falhou: ' + (e.message || e)); }
    }
  } finally { analisando = false; }
}
setInterval(huntLoop, 60000);
setTimeout(huntLoop, 60000);

// ---- aprovacoes: compras/vendas e qualquer acao arriscada passam por aqui ----
const pending = {};
let pid = 1;
async function run(call, args, acc) {
  const fn = actions[call];
  if (!fn) throw new Error('acao desconhecida: ' + call);
  // leituras nao vao para o log (so acoes que mudam algo no jogo)
  if (!['status', 'text', 'estoque', 'eval', 'shot', 'accounts', 'mode', 'ficha', 'hunt', 'avaliarHunt', 'restock'].includes(call) || (call === 'restock' && !args.dry))
    log(acc, call + ' ' + JSON.stringify(Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'acc'))));
  return fn(args);
}

const routes = {
  async rules() { return rules(); },
  // painel Automacao: GET devolve a config da conta + precos conhecidos; POST (corpo JSON) salva em rules.json
  async automacao({ acc }, body) {
    if (!PORTS[acc]) throw new Error('conta desconhecida: ' + acc);
    if (body) {
      const a = JSON.parse(body), R = readJson(RULES, {});
      const itens = {};
      for (const i of ITENS) {
        const r = (a.itens || {})[i] || {};
        const abaixo = Math.max(0, Math.floor(+r.abaixo || 0)), ate = Math.max(0, Math.min(1000, Math.floor(+r.ate || 0)));
        itens[i] = { abaixo, ate: Math.max(ate, abaixo ? abaixo : 0) };
      }
      R.accounts = R.accounts || {};
      R.accounts[acc] = { ...(R.accounts[acc] || {}), auto: { ativo: a.ativo !== false, guardarOuro: Math.max(0, Math.floor(+a.guardarOuro || 0)), itens } };
      fs.writeFileSync(RULES, JSON.stringify(R, null, 2));
      log(acc, 'automacao salva: ' + (a.ativo === false ? 'desligada' : 'ligada') + ', guarda ' + (R.accounts[acc].auto.guardarOuro).toLocaleString('pt-BR') + ' de ouro');
      return automacao(acc);
    }
    return { ...automacao(acc), itensOrdem: ITENS, precos: readJson(path.join(__dirname, 'data', 'precos.json'), {}) };
  },
  async saverules(q, body) { JSON.parse(body); fs.writeFileSync(RULES, body); log('-', 'regras salvas'); return 'ok'; },
  async overview() {
    return { status: statusCache, pending: Object.values(pending), log: recent.slice(-40).reverse(), open: Object.keys(ctxs), mode: actions.mode() };
  },
  async hunts() {
    const r = rules();
    return Object.entries(hunts).map(([hunt, h]) => ({
      hunt, horas: +(h.sec / 3600).toFixed(2),
      xpPorHora: h.sec > 60 ? Math.round(h.xp / (h.sec / 3600)) : null,
      ouroPorHora: h.sec > 60 ? Math.round(h.gold / (h.sec / 3600)) : null,
      diasShiny: Object.entries(r.shinyDaysAvg || {}).find(([k]) => hunt.startsWith(k))?.[1] ?? null,
    })).sort((a, b) => (b.xpPorHora || 0) - (a.xpPorHora || 0));
  },
  // propoe uma acao: espera aprovacao no painel (ou executa direto se a conta estiver em modo livre)
  async propose({ acc, desc, call, args }) {
    const a = JSON.parse(args || '{}'); a.acc = acc;
    if (rules().accounts?.[acc]?.freeMode) return { executed: true, result: await run(call, a, acc) };
    const id = pid++; pending[id] = { id, acc, desc, call, args: a, at: Date.now() };
    log(acc, 'proposta #' + id + ': ' + desc);
    return { pendingId: id };
  },
  async approve({ id }) {
    const p = pending[id]; if (!p) throw new Error('nao existe');
    delete pending[id]; return run(p.call, p.args, p.acc);
  },
  async reject({ id }) { delete pending[id]; log('-', 'recusada #' + id); return 'ok'; },
  // ranking de hunts feito pelo pokeidleguide.io a partir da ficha do pokemon em campo
  async rank({ acc }) {
    const r = await run('hunt', { acc }, acc);
    ranks[acc] = { ...r, at: Date.now() };
    fs.writeFile(RANKS, JSON.stringify(ranks), () => {});
    return r;
  },
  // analisa as contas logadas, uma por vez (o site e um so), e devolve o resumo da melhor hunt de cada uma
  async rankall() {
    const out = {};
    for (const acc of Object.keys(PORTS)) {
      if (!statusCache[acc]?.loggedIn) { out[acc] = { erro: 'conta nao logada' }; continue; }
      try {
        const r = await routes.rank({ acc });
        out[acc] = Object.fromEntries(Object.entries(r.recomendacao).map(([k, v]) => [k, v.melhor && `${v.melhor.pokemon} Nv ${v.melhor.nivel} (${v.melhor.valor})`]));
      } catch (e) { out[acc] = { erro: String(e.message || e) }; }
    }
    return out;
  },
  async rankings() { return ranks; },
  async consumo({ acc }) { return consumo(acc); },
  // poe a conta (ou todas, acc=todas) na melhor hunt do criterio; guarda a analise feita no caminho
  async irmelhor({ acc, crit, forcar }) {
    const contas = !acc || acc === 'todas' ? Object.keys(PORTS).filter(a => statusCache[a]?.loggedIn) : [acc];
    const out = {};
    for (const a of contas) {
      try {
        const r = await run('irMelhor', { acc: a, crit, forcar }, a);
        ranks[a] = { ...r.analise, at: Date.now() }; fs.writeFile(RANKS, JSON.stringify(ranks), () => {});
        const ida = r.ida || {};
        out[a] = (ida.ficou ? `ficou onde estava (${ida.motivo}); melhor seria ${r.alvo}` : `${ida.jaEstava ? 'ja estava em' : 'foi para'} ${r.alvo}`) +
          (r.curou ? ' · curou' : '') + (r.principal && r.principal.trocou ? ' · principal de volta: ' + r.principal.principal : '') +
          (ida.forcado ? ` · desistiu do combate${ida.perda ? ' (' + ida.perda + ')' : ''}${ida.curou ? ' e curou' : ''}` : '');
        log(a, 'hunt: ' + out[a]);
      } catch (e) { out[a] = 'erro: ' + (e.message || e); log(a, 'hunt falhou: ' + out[a]); }
    }
    return out;
  },
  // recompra agora (sem esperar o intervalo); dry=1 so mostra o plano
  async recomprar({ acc, dry }) {
    const r = await actions.restock({ acc, dry });
    const feitas = r.compras.filter(c => c.resultado);
    if (feitas.length) log(acc, 'recompra: ' + feitas.map(c => `${c.qtd} ${c.item}`).join(', '));
    ultimoRestock[acc] = Date.now();
    return r;
  },
  async tickNow() { await tick(); return statusCache; },
  // RAM/CPU medidos pelo PokeBot.exe (a cada 2 s)
  // o POST do host recebe de volta os avisos pendentes (e a fila e esvaziada)
  async metrics(q, body) { if (body) { metrics = JSON.parse(body); return { notificacoes: avisos.splice(0) }; } return metrics; },
};

// ---- Conector MCP por HTTP (para apps como o Grok Bot), so neste PC e com chave ----
// Endereco: http://127.0.0.1:8787/mcp  ·  chave em config/app.json -> mcp.chave (cabecalho Authorization: Bearer <chave>
// ou ?key=<chave> na URL). So expoe as ferramentas "seguras" (sem JavaScript livre nem clique livre).
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { criarServidor } = require('./mcp/tools');
function mcpCfg() {
  const cfg = readJson(APPCFG, {});
  if (!cfg.mcp || !cfg.mcp.chave) {
    cfg.mcp = { ativo: true, chave: require('crypto').randomBytes(18).toString('base64url'), ...(cfg.mcp || {}) };
    fs.writeFileSync(APPCFG, JSON.stringify(cfg, null, 2));
  }
  return cfg.mcp;
}
mcpCfg();
const mcpCall = async (p, params = {}, body) => {
  if (routes[p]) return routes[p](params, body);
  if (actions[p]) return run(p, params, params.acc);
  throw new Error('acao desconhecida: ' + p);
};
async function mcpHttp(req, res, u) {
  const cfg = mcpCfg();
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!cfg.ativo || (auth !== cfg.chave && u.searchParams.get('key') !== cfg.chave)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end('{"error":"chave invalida ou conector desligado"}');
  }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
  let raw = ''; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : undefined;
  const server = criarServidor(mcpCall, { completo: false });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const name = u.pathname.slice(1);
  if (name === 'mcp') {
    try { return await mcpHttp(req, res, u); }
    catch (e) { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: String(e.message || e) })); }
  }
  if (name === '' || /^[\w-]+\.html$/.test(name)) { // paginas dos paineis (ui/*.html)
    const f = path.join(__dirname, 'ui', name || 'index.html');
    // os paineis recebem os nomes das contas daqui (window.CONTAS), em vez de te-los escritos no HTML
    if (fs.existsSync(f)) { res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(fs.readFileSync(f, 'utf8').replace('<script>', `<script>window.CONTAS=${JSON.stringify(CONTAS)};</script><script>`)); }
  }
  res.setHeader('content-type', 'application/json; charset=utf-8');
  const q = Object.fromEntries(u.searchParams);
  try {
    let body = ''; for await (const c of req) body += c;
    let out;
    if (routes[name]) out = await routes[name](q, body);
    else if (actions[name]) out = await run(name, q, q.acc);
    else { res.statusCode = 404; return res.end('{"error":"unknown"}'); }
    res.end(JSON.stringify({ ok: true, result: out }));
  } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); }
}).listen(PORT, '127.0.0.1', () => { console.log('PokeBot em http://127.0.0.1:' + PORT); tick(); });
