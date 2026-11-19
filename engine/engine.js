// Motor do PokeBot: conecta por CDP (porta local 930x) em cada conta.
// Modo "app" (padrao): as contas rodam dentro do PokeBot.exe (WebView2, motor do Edge); o motor so se conecta.
// Modo "chrome" (reserva): abre um Chrome por conta, como na primeira versao.
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const URL_GAME = 'https://pokeidle.io';
let appCfg = {};
try { appCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'app.json'), 'utf8')); } catch {}
const MODE = process.env.POKEBOT_MODE || appCfg.mode || 'app';
const CHROME = appCfg.chromePath || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// Nomes das 4 contas: config/contas.json (so neste PC; o modelo e config/contas.example.json)
function lerContas() {
  for (const f of ['contas.json', 'contas.example.json']) {
    try { const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', f), 'utf8')).contas; if (Array.isArray(c) && c.length) return c.slice(0, 4); } catch {}
  }
  return ['conta1', 'conta2', 'conta3', 'conta4'];
}
const CONTAS = lerContas();
const PORTS = Object.fromEntries(CONTAS.map((n, i) => [n, 9301 + i]));
const ctxs = {};

const connect = (port) => chromium.connectOverCDP('http://127.0.0.1:' + port);

function gamePage(browser) {
  const pages = browser.contexts().flatMap(c => c.pages());
  return pages.find(p => p.url().includes('pokeidle.io')) || pages[0];
}

// PokeBot.exe novo: um navegador so (porta 9300) com um perfil por conta. Cada pagina recebe do host a marca
// window.__pokebotAcc com o nome da conta, e e por ela que o motor acha a pagina certa.
// Se a porta 9300 nao responder, usa o modo antigo (um navegador por conta, portas 9301-9304).
const SHARED_PORT = 9300;
let shared = null;
async function sharedBrowser() {
  if (shared && shared.isConnected()) return shared;
  shared = await connectSoJogo(SHARED_PORT).catch(() => null);
  return shared;
}

// Conexao com o deck que so enxerga as paginas do jogo. O Playwright se liga a TODAS as paginas do navegador
// (e liga o Runtime nelas); o anti-robo da Kick percebe isso e trava o login (visto em 18/11/2026). Aqui o
// transporte fica entre o Playwright e o navegador: pagina que nao e do pokeidle.io (Kick, Twitch, anuncios,
// janelas do deck) e solta na hora, sem o Playwright nem saber que ela existe; so as do jogo (e os frames
// delas) chegam ao motor.
async function connectSoJogo(port) {
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  const ligadas = new Set();   // sessoes das paginas do jogo (e dos frames dentro delas)
  let idProprio = 2e9;         // ids dos nossos pedidos (soltar pagina), para nao repassar as respostas
  const fila = [];
  const transporte = {
    onmessage: undefined,
    onclose: undefined,
    send(msg) { const s = JSON.stringify(msg); if (ws.readyState === 1) ws.send(s); else fila.push(s); },
    close() { try { ws.close(); } catch {} },
  };
  const soltar = (sessionId, pai) => {
    ws.send(JSON.stringify({ id: idProprio++, method: 'Runtime.runIfWaitingForDebugger', sessionId }));
    ws.send(JSON.stringify({ id: idProprio++, method: 'Target.detachFromTarget', params: { sessionId }, ...(pai ? { sessionId: pai } : {}) }));
  };
  ws.addEventListener('message', (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.id >= 2e9) return;                                  // resposta de um "soltar" nosso
    if (m.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = m.params;
      const doJogo = m.sessionId ? ligadas.has(m.sessionId)
        : targetInfo.type === 'page' && /^https:\/\/pokeidle\.io\//.test(targetInfo.url || '');
      if (!doJogo) {
        if (!m.sessionId) console.log(`[deck] pagina solta (nao e do jogo): ${(targetInfo.url || '(vazia)').slice(0, 80)}`);
        soltar(sessionId, m.sessionId); return;
      }
      if (!m.sessionId) console.log(`[deck] pagina do jogo ligada: ${targetInfo.url}`);
      ligadas.add(sessionId);
    } else if (m.method === 'Target.detachedFromTarget') {
      if (!ligadas.delete(m.params.sessionId)) return;
    } else if (m.sessionId && !ligadas.has(m.sessionId)) {
      return;                                                 // evento de uma pagina solta
    }
    if (transporte.onmessage) transporte.onmessage(m);
  });
  ws.addEventListener('close', () => { if (transporte.onclose) transporte.onclose('o deck fechou a conexao'); });
  await new Promise((ok, falha) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', falha, { once: true }); });
  for (const s of fila.splice(0)) ws.send(s);
  const browser = await chromium.connectOverCDP(transporte);
  // Desconecta SO o motor (fecha o nosso socket). Nunca usar browser.close() aqui: fecharia o navegador do deck.
  browser.__desconectar = () => transporte.close();
  return browser;
}
// Acha a pagina do jogo da conta: no PokeBot.exe pela marca __pokebotAcc (o nome); no PokeIdle Deck pela marca
// __pokebotPerfil (conta1..conta4, na ordem do config/contas.json). As lives e janelas do deck nao tem marca.
async function sharedPage(browser, name) {
  const perfil = 'conta' + (CONTAS.indexOf(name) + 1);
  for (let i = 0; i < 2; i++) {
    for (const p of browser.contexts().flatMap(c => c.pages())) {
      const m = await p.evaluate(() => [window.__pokebotAcc, window.__pokebotPerfil]).catch(() => null);
      if (m && (m[0] === name || m[1] === perfil)) return p;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

async function open(name) {
  const cur = ctxs[name];
  if (cur && cur.browser.isConnected() && !cur.page.isClosed()) return cur;
  const port = PORTS[name];
  if (!port) throw new Error('conta desconhecida: ' + name);
  if (MODE === 'app') {
    const sb = await sharedBrowser();
    if (sb) {
      const page = await sharedPage(sb, name);
      if (!page) {
        // O deck acabou de abrir e a pagina ainda estava em branco quando o motor conectou (e foi solta):
        // desconecta para a proxima tentativa ver a pagina ja no jogo.
        if (sb.__desconectar) { sb.__desconectar(); shared = null; }
        throw new Error(`conta ${name} nao encontrada (pagina do jogo sem a marca da conta; ela esta ligada no deck?)`);
      }
      return (ctxs[name] = { ctx: page.context(), page, browser: sb });
    }
  }
  let browser = await connect(port).catch(() => null);
  if (!browser && MODE === 'chrome') {
    spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(ROOT, 'profiles', name)}`,
      '--no-first-run', '--no-default-browser-check', URL_GAME], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 30 && !browser; i++) { await new Promise(r => setTimeout(r, 500)); browser = await connect(port).catch(() => null); }
  }
  if (!browser) throw new Error(MODE === 'app' ? `conta ${name} nao esta aberta (abra o PokeBot.exe)` : 'navegador nao abriu');
  const page = gamePage(browser);
  if (!page) throw new Error('pagina do jogo nao encontrada: ' + name);
  browser.on('disconnected', () => { if (ctxs[name]?.browser === browser) delete ctxs[name]; });
  return (ctxs[name] = { ctx: page.context(), page, browser });
}

// Navegador invisivel so para o pokeidleguide.io (site de ferramenta, sem login): nenhuma aba para voce.
let helper = null;
async function helperContext() {
  if (!helper || !helper.isConnected()) helper = await chromium.launch({ channel: 'msedge', headless: true });
  return helper.newContext();
}

// Clica no centro do primeiro elemento VISIVEL cujo texto e exatamente `label`.
async function clickVisible(page, label) {
  const box = await page.evaluate((label) => {
    const els = [...document.querySelectorAll('button,div,span,a,li')].filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' &&
        e.innerText && e.innerText.trim() === label;
    });
    els.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height -
      b.getBoundingClientRect().width * b.getBoundingClientRect().height);
    const dentro = els.filter(e => { const q = e.getBoundingClientRect(); return q.top >= 0 && q.bottom <= innerHeight && q.left >= 0 && q.right <= innerWidth; });
    const e0 = dentro[0] || els[0];
    if (e0) {
      const q = e0.getBoundingClientRect();
      if (q.top < 0 || q.bottom > innerHeight || q.left < 0 || q.right > innerWidth) e0.scrollIntoView({ block: 'center' });
    }
    const r = e0?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  }, label);
  if (!box) throw new Error('nao achei visivel: ' + label);
  await page.mouse.click(box.x, box.y);
}

// "Copiar p/ ChatGPT" do pokemon EM CAMPO: abre a ficha e captura o texto copiado (sem tocar na area de transferencia).
// Usa os locators do Playwright (respeitam o zoom da conta) e o cartao .ativo-card do layout de 3 colunas.
async function ficha(page) {
  await page.keyboard.press('Escape').catch(() => {});
  // Intercepta a copia SO durante este clique e NAO escreve na area de transferencia do Windows (antes escrevia e
  // atrapalhava o seu Ctrl+C / Ctrl+V). Depois devolve as funcoes originais do jogo.
  await page.evaluate(() => {
    window.__clip = null;
    const cb = navigator.clipboard, doc = document;
    if (window.__pbRestore) window.__pbRestore();
    const o = { wt: cb.writeText, w: cb.write, ex: doc.execCommand };
    cb.writeText = async (t) => { window.__clip = String(t); };
    cb.write = async (itens) => {
      try { for (const it of itens) if (it.types.includes('text/plain')) { window.__clip = await (await it.getType('text/plain')).text(); } } catch {}
    };
    doc.execCommand = function (cmd) { if (String(cmd).toLowerCase() === 'copy') { window.__clip = String(getSelection()); return true; } return o.ex.apply(doc, arguments); };
    window.__pbRestore = () => { cb.writeText = o.wt; cb.write = o.w; doc.execCommand = o.ex; window.__pbRestore = null; };
    setTimeout(() => { if (window.__pbRestore) window.__pbRestore(); }, 15000); // seguranca
  });
  let card = page.locator('.ativo-card >> visible=true').first();
  if (!(await card.count())) { // layout empilhado (janela estreita): abre a aba Equipe
    await clickVisible(page, 'Equipe').catch(() => {});
    await page.waitForTimeout(800);
    card = page.locator('.ativo-card >> visible=true').first();
  }
  if (!(await card.count())) throw new Error('pokemon em campo nao encontrado');
  const btn = page.locator('text="Copiar p/ ChatGPT" >> visible=true').first();
  // Se a ficha ja estiver aberta (sobrou de antes), usa ela. Senao abre pelo cartao do pokemon em campo.
  // Outras janelas/abas do jogo as vezes ficam por cima do cartao ("intercepts pointer events"): nesse caso
  // o clique vai direto pelo DOM, que ignora o que esta por cima.
  if (!(await btn.count())) {
    await card.locator('.ativo-nome').first().click({ timeout: 3000 })
      .catch(() => card.evaluate(el => (el.querySelector('.ativo-nome') || el).click()));
  }
  await btn.waitFor({ state: 'visible', timeout: 6000 });
  await btn.click({ timeout: 3000 }).catch(() => btn.evaluate(el => (el.closest('button') || el).click()));
  await page.waitForFunction(() => !!window.__clip, null, { timeout: 4000 }).catch(() => {});
  const txt = await page.evaluate(() => { if (window.__pbRestore) window.__pbRestore(); return window.__clip; });
  if (!txt) throw new Error('nao consegui copiar a ficha');
  return txt;
}

// ---- Analise de hunts (motor do pokeidleguide.io/#hunt, o mesmo da extensao /hunt) ----
// Uma aba invisivel fica aberta no site e e reaproveitada: as analises seguintes nao recarregam a pagina.
let guidePage = null;
const guideQueue = []; let guideBusy = false;
function guideLock(fn) {
  return new Promise((res, rej) => { guideQueue.push(async () => { try { res(await fn()); } catch (e) { rej(e); } }); pump(); });
  async function pump() { if (guideBusy) return; guideBusy = true; while (guideQueue.length) await guideQueue.shift()(); guideBusy = false; }
}
async function getGuidePage() {
  if (guidePage && !guidePage.isClosed() && helper && helper.isConnected()) return guidePage;
  const ctx = await helperContext();
  guidePage = await ctx.newPage();
  await guidePage.goto('https://pokeidleguide.io/#hunt', { waitUntil: 'domcontentloaded' });
  await guidePage.waitForSelector('#ph-ficha', { timeout: 30000 });
  return guidePage;
}

// tipo do dia do jogo (em portugues) -> valor do site
const TIPOS = [['NORMAL', 'NORMAL'], ['FOGO', 'FIRE'], ['AGUA', 'WATER'], ['PLANTA', 'GRASS'], ['GRAMA', 'GRASS'], ['ELETRIC', 'ELECTRIC'],
  ['GELO', 'ICE'], ['LUTA', 'FIGHTING'], ['VENEN', 'POISON'], ['TERR', 'GROUND'], ['VOADOR', 'FLYING'], ['PSIQUIC', 'PSYCHIC'],
  ['INSETO', 'BUG'], ['PEDRA', 'ROCK'], ['ROCHA', 'ROCK'], ['FANTASMA', 'GHOST'], ['DRAG', 'DRAGON'], ['SOMBRIO', 'DARK'],
  ['NOTURNO', 'DARK'], ['ACO', 'STEEL'], ['METAL', 'STEEL'], ['FADA', 'FAIRY']];
function tipoDoDia(texto) {
  const lines = texto.split('\n').map(s => s.trim()).filter(Boolean);
  const k = lines.findIndex(l => /^TIPAGEM DO DIA/i.test(l));
  if (k < 0) return '';
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  for (const l of lines.slice(k + 1, k + 5)) { const n = norm(l); const t = TIPOS.find(([pt]) => n.startsWith(pt)); if (t) return t[1]; }
  return '';
}

// "112,3 mil" -> 112300 ; "1,2 mi" -> 1200000 ; "67 d 15 capturas/h" -> 67
function numBR(s) {
  const m = String(s || '').match(/([\d.]+(?:,\d+)?)\s*(mil|mi|bi)?/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
  return Math.round(v * ({ mil: 1e3, mi: 1e6, bi: 1e9 }[m[2]] || 1));
}

// Linha da tabela do site -> objeto. Colunas: # | hunt | valor do criterio | abates/h | mata em | risco | outro valor
function rowObj(c) {
  const m = (c[1] || '').match(/^(.*?) Nv (\d+)\s+(\S+)\s*(.*)$/) || [0, c[1], null, '', ''];
  const rt = c[5] || '';
  const riscoPct = /hit/i.test(rt) ? 100 : (parseInt(rt.replace(/\D/g, '')) || 0);
  return {
    pos: parseInt(String(c[0]).replace(/\D/g, '')) || null, pokemon: m[1], nivel: m[2] ? +m[2] : null, regiao: m[3], tipos: m[4],
    valor: c[2], valorNum: numBR(c[2]), abatesH: numBR(c[3]), mataEm: c[4], risco: rt.replace(/[^\w%,\s]/g, '').trim(), riscoPct,
    umGolpe: /hit/i.test(rt), raw: c,
  };
}

// Cola a ficha no site com nivel, bola, tipo do dia e "so hunts liberadas", e le os 3 rankings.
async function huntRank(fichaTxt, nivel, sorts, opts = {}) {
  return guideLock(async () => {
    const p = await getGuidePage();
    const tabelaAntes = await p.evaluate(() => document.querySelector('main tbody')?.innerText || '');
    await p.evaluate(({ fichaTxt, nivel, bola, dia }) => {
      const set = (el, v) => {
        if (!el) return;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const lib = [...document.querySelectorAll('input[type=checkbox]')].find(c => /hunts liberadas/i.test((c.closest('label') || c.parentElement).innerText));
      if (lib && !lib.checked) lib.click();
      set(document.getElementById('ph-bola'), String(bola));
      set(document.getElementById('ph-dia'), dia || '');
      set(document.getElementById('ph-nivel'), String(nivel));
      set(document.getElementById('ph-ficha'), ''); // forca recalculo mesmo se a ficha for igual
      set(document.getElementById('ph-ficha'), fichaTxt);
    }, { fichaTxt, nivel, bola: opts.bola || 4, dia: opts.dia || '' });
    await p.waitForFunction(() => document.querySelectorAll('main tbody tr').length > 3, null, { timeout: 30000 });
    // espera o site recalcular para ESTA ficha (senao lemos a tabela da conta anterior)
    if (tabelaAntes) await p.waitForFunction((a) => (document.querySelector('main tbody')?.innerText || '') !== a, tabelaAntes, { timeout: 12000 }).catch(() => {});
    const out = {};
    for (const s of sorts) {
      const antes = await p.evaluate(() => document.querySelector('main tbody')?.innerText || '');
      await p.evaluate((s) => {
        const b = [...document.querySelectorAll('main button,main label,main span,main div')]
          .filter(e => e.innerText?.trim() === s && e.getBoundingClientRect().width > 0).sort((a, b) => a.innerText.length - b.innerText.length)[0];
        b?.click();
      }, s);
      // espera a tabela mudar (ate 3 s) em vez de uma pausa fixa
      await p.waitForFunction((a) => (document.querySelector('main tbody')?.innerText || '') !== a, antes, { timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(150);
      out[s] = await p.evaluate(() => [...document.querySelectorAll('main tbody tr')].slice(0, 15).map(tr =>
        [...tr.querySelectorAll('td')].map(td => td.innerText.replace(/\s+/g, ' ').trim())));
    }
    return out;
  });
}

// Escolhe a melhor hunt por criterio: a 1a do ranking que nao mata em 1 golpe e tem risco <= limite.
function recomendar(ranking, riscoMax = 30) {
  const rec = {};
  for (const [crit, rows] of Object.entries(ranking)) {
    const objs = rows.map(rowObj);
    const seguras = objs.filter(o => !o.umGolpe && o.riscoPct <= riscoMax);
    rec[crit] = { melhor: seguras[0] || null, segunda: seguras[1] || null, topoAbsoluto: objs[0] || null };
  }
  return rec;
}

function parseStatus(t, acc) {
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
  // o nivel do treinador e o "Nv N" logo depois do nome da conta (outros "Nv N" da tela sao de pokemon)
  let i = acc ? lines.findIndex((l, k) => l === acc && /^Nv \d+$/.test(lines[k + 1] || '')) + 1 : 0;
  if (i <= 0) i = lines.findIndex(l => /^Nv \d+$/.test(l));
  const num = s => (s == null ? null : +String(s).replace(/\./g, '').replace(/,/g, ''));
  const xp = t.match(/([\d.]+) \/ ([\d.]+) xp/);
  const hunt = lines.find(l => /· nível \d+$/.test(l));
  // depois de "Nv N" vem (em qualquer ordem de layout) a linha de xp e os 3 saldos: ouro, diamante, gema
  const saldos = i > 0 ? lines.slice(i + 1, i + 6).filter(l => /^[\d.]+$/.test(l)).map(num) : [];
  // painel "SESSÃO" do proprio jogo: valor por hora logo apos o rotulo
  const porHora = (rot) => { const k = lines.findIndex(l => l.toUpperCase().startsWith(rot)); const v = k >= 0 ? lines[k + 2] : null; return v && /\/h$/.test(v) ? num(v.replace('/h', '')) : null; };
  return {
    loggedIn: i > 0 && !!xp,
    name: i > 0 ? lines[i - 1] : null,
    level: i > 0 ? +lines[i].slice(3) : null,
    gold: saldos[0] ?? null,
    diamonds: saldos[1] ?? null,
    gems: saldos[2] ?? null,
    xpPorHora: porHora('XP TREINADOR'),
    lucroPorHora: porHora('LUCRO L'),
    abatesPorHora: porHora('ABATES'),
    xp: xp ? num(xp[1]) : null,
    xpMax: xp ? num(xp[2]) : null,
    hunt: hunt || null,
    event: lines.find(l => l.startsWith('🎉')) || null,
    // so mensagens do proprio jogo (o chat tem "HH:MM Nome [n]: ...")
    log: lines.filter(l => !/^\d\d:\d\d /.test(l) && /derrotado|poção usada|capturad|shiny|desmai/i.test(l)).slice(-5),
  };
}

// Compra no Market (aba Comprar > categoria ja aberta): preenche a quantidade e clica Comprar.
async function buy(page, item, qty) {
  qty = Math.floor(+qty);
  if (!(qty >= 1 && qty <= 1000)) throw new Error('quantidade invalida');
  const h = await page.evaluateHandle((item) => {
    // nome exato numa linha propria ("Revive" nao pode pegar o cartao do "Max Revive"); so cartoes visiveis
    const cards = [...document.querySelectorAll('div')].filter(d => d.innerText && d.getBoundingClientRect().width > 0 &&
      d.innerText.split('\n').some(l => l.trim() === item) &&
      d.innerText.includes('Comprar') && d.querySelector('input') && d.innerText.length < 200);
    cards.sort((a, b) => a.innerText.length - b.innerText.length);
    return cards[0] || null;
  }, item);
  const card = h.asElement();
  if (!card) throw new Error('item nao encontrado: ' + item);
  const have = async () => (await card.innerText()).match(/você tem ×([\d.]+)/)?.[1];
  const antes = await have();
  await (await card.$('input')).fill(String(qty));
  await card.evaluate((c) => {
    [...c.querySelectorAll('button')].filter(b => /^Comprar/.test(b.innerText.trim())).pop().click();
  });
  await page.waitForTimeout(800);
  return { item, qty, antes, depois: await have() };
}

// ---- Trocar de hunt pelo Mapa (modo Lista), como voce faria clicando ----
// O proprio jogo recusa a troca durante um combate ou logo apos outra troca (a linha "treme" e aparece um aviso);
// entao clicamos de novo a cada ~1,5 s ate o jogo aceitar (no maximo `espera` segundos). Nada e burlado.
async function cacar(page, nome, nivel, espera = 45) {
  const huntAtual = () => page.evaluate(() => {
    const eco = [...document.querySelectorAll('#eco-onde')].find(e => e.getBoundingClientRect().width > 0);
    if (eco && /· nível \d+$/.test(eco.innerText.trim())) return eco.innerText.trim();
    return [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && !e.closest('.modal') &&
      e.getBoundingClientRect().width > 0 && /· nível \d+$/.test(e.innerText || '')).map(e => e.innerText.trim())[0] || null;
  });
  const alvo = `${nome} · nível ${nivel}`;
  if ((await huntAtual()) === alvo) return { ok: true, hunt: alvo, jaEstava: true };
  await fecharModais(page);
  if (!(await page.locator('#f-mapa >> visible=true').count())) {
    // atalho do proprio jogo: tecla M abre o Mapa (funciona em qualquer layout, inclusive no Modo Economia)
    await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
    await page.keyboard.press('m');
    const abriu = await page.locator('#f-mapa >> visible=true').first().waitFor({ timeout: 3000 }).then(() => true, () => false);
    if (!abriu) {
      const qual = await clicarVisivel(page, ['button:text-is("Mapa")', 'button[title*="Mapa"]']);
      if (!qual) throw new Error('nao consegui abrir o Mapa');
      await page.locator('#f-mapa >> visible=true').first().waitFor({ timeout: 8000 });
    }
  }
  const lista = page.locator('button.mapa-modo-bt:has-text("LISTA") >> visible=true').first();
  if (await lista.count()) await lista.click();
  await page.locator('#f-mapa >> visible=true').first().fill(nome);
  await page.waitForTimeout(600);
  const linhas = page.locator('button.ml-linha >> visible=true');
  let linha = null;
  for (let i = 0; i < await linhas.count(); i++) {
    const t = (await linhas.nth(i).innerText()).replace(/\s+/g, ' ');
    if (t.startsWith(nome + ' ') && new RegExp(`Nv ${nivel}\\b`).test(t)) { linha = linhas.nth(i); break; }
  }
  if (!linha) throw new Error(`hunt ${nome} Nv ${nivel} nao encontrada no mapa (liberada para esta conta?)`);
  const fim = Date.now() + espera * 1000;
  let tentativas = 0;
  while (Date.now() < fim) {
    tentativas++;
    await linha.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(700);
    // se essa ja e a hunt escolhida (ex.: a equipe voltou ao Centro), o clique abre o Hunt Analyser: "Caçar aqui"
    await clicarVisivel(page, ['.ha-cacar', 'button:has-text("Caçar aqui")']);
    await page.waitForTimeout(800);
    if ((await huntAtual()) === alvo) { await page.keyboard.press('Escape').catch(() => {}); return { ok: true, hunt: alvo, tentativas }; }
    if (!(await linha.isVisible().catch(() => false))) break; // o mapa fechou: o jogo aceitou e esta indo
  }
  await page.waitForTimeout(2000);
  const h = await huntAtual();
  await page.keyboard.press('Escape').catch(() => {});
  if (h === alvo) return { ok: true, hunt: alvo, tentativas };
  throw new Error(`o jogo nao aceitou a troca em ${espera}s (em combate?). Hunt atual: ${h}`);
}

// fecha janelas do jogo que ficaram abertas (ficha de especie, pokedex etc.) — so pelo X, nunca confirma nada
async function fecharModais(page) {
  await page.keyboard.press('Escape').catch(() => {});
  for (let i = 0; i < 3; i++) {
    const fechou = await page.evaluate(() => {
      const m = [...document.querySelectorAll('.modal')].filter(e => e.getBoundingClientRect().width > 0).pop();
      if (!m) return false;
      const x = [...m.querySelectorAll('button')].find(b => b.innerText.trim() === '×' && b.getBoundingClientRect().width > 0);
      if (x) x.click();
      return !!x;
    }).catch(() => false);
    if (!fechou) break;
    await page.waitForTimeout(400);
  }
}

// clica no primeiro botao visivel de uma lista de seletores; devolve qual clicou
async function clicarVisivel(page, seletores) {
  for (const s of seletores) {
    const b = page.locator(`${s} >> visible=true`).first();
    if (await b.count()) { await b.click({ timeout: 3000 }).catch(() => {}); return s; }
  }
  return null;
}

// Se a equipe esta no Centro Pokemon (desmaiou/voltou), cura.
async function curarSePreciso(page) {
  const c = await clicarVisivel(page, ['#centro-curar', '#eco-curar', 'button:has-text("Curar equipe")']);
  if (c) await page.waitForTimeout(1500);
  return !!c;
}

// O "principal" em campo = o pokemon de maior nivel da equipe. Quando o principal desmaia o jogo poe outro
// (ex.: um Geodude Nv1) em campo; aqui ele volta. Clicar na linha da equipe coloca o pokemon em campo.
async function garantirPrincipal(page) {
  const linhas = page.locator('.poke-linha >> visible=true');
  if (!(await linhas.count())) { await clickVisible(page, 'Equipe').catch(() => {}); await page.waitForTimeout(800); }
  const info = await page.evaluate(() => [...document.querySelectorAll('.poke-linha')].filter(l => l.getBoundingClientRect().width > 0)
    .map((l, i) => ({ i, ativo: l.classList.contains('ativo'), nome: (l.innerText.match(/^(.+?) Nv ?(\d+)/m) || [])[1] || '', nv: +((l.innerText.match(/Nv ?([\d.]+)/) || [])[1] || '0').replace(/\./g, '') })));
  if (!info.length) return null;
  const melhor = info.reduce((a, b) => (b.nv > a.nv ? b : a));
  if (melhor.ativo) return { trocou: false, principal: `${melhor.nome} Nv ${melhor.nv}` };
  await linhas.nth(melhor.i).click({ timeout: 3000 });
  await page.waitForTimeout(1000);
  return { trocou: true, principal: `${melhor.nome} Nv ${melhor.nv}` };
}

// ---- Troca de hunt direta (PokeIdle Deck com o pokebot.js) ----
// O deck guarda a lista de hunts do proprio jogo (slug + nivel) e manda os mesmos pedidos dos botoes:
// hunt.select, centro.desistir e centro.curar. Sem a ponte (PokeBot.exe, deck antigo) devolve null e o motor
// usa o Mapa na tela, como antes.
const normNome = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/♀/g, '-f').replace(/♂/g, '-m').replace(/[.'’:]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
async function ponte(page) {
  return page.evaluate(() => (window.__pokebot ? window.__pokebot.estado() : null)).catch(() => null);
}
async function slugDaHunt(page, nome, nivel) {
  const hunts = await page.evaluate(() => window.__pokebot.hunts()).catch(() => null);
  if (!Array.isArray(hunts)) return null;
  const n = normNome(nome), nv = +nivel;
  const doNivel = hunts.filter(h => +h.nivel === nv);
  const porNome = (h) => normNome(h.nome) === n || h.slug === n || h.slug.startsWith(n + '-') || h.slug.endsWith('-' + n);
  const achadas = doNivel.filter(porNome);
  return achadas.length === 1 ? achadas[0].slug : (achadas.find(h => h.slug === n) || {}).slug || null;
}
async function esperarHunt(page, slug, ms) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const e = await ponte(page);
    if (e && e.huntSlug === slug && !e.noCentro) return true;
    await page.waitForTimeout(400);
  }
  return false;
}
async function irParaDireto(page, nome, nivel, forcar) {
  const e = await ponte(page);
  if (!e || !e.conectado || !e.hunts) return null;
  const slug = await slugDaHunt(page, nome, nivel);
  if (!slug) return null; // nome nao bateu com a lista do jogo: o Mapa resolve
  const alvo = `${nome} · nível ${nivel}`;
  // no Centro (desmaiou) a hunt continua marcada, mas a equipe nao esta cacando: precisa escolher de novo
  if (e.huntSlug === slug && !e.noCentro) return { ok: true, hunt: alvo, jaEstava: true, direto: true };
  const enviar = (obj) => page.evaluate((o) => window.__pokebot.enviar(o), obj);
  // no Centro: cura antes de voltar (curar com a equipe cheia nao custa nada)
  if (e.noCentro) { await enviar({ t: 'centro.curar' }); await page.waitForTimeout(1500); }
  // o jogo so troca fora de combate (~3 s sem dano): reenvia a cada 2 s para pegar a brecha entre uma luta e outra
  const insistir = forcar ? 10000 : 30000;
  const fim = Date.now() + insistir;
  let tentativas = 0;
  while (Date.now() < fim) {
    tentativas++;
    if ((await enviar({ t: 'hunt.select', slug })) !== 'ok') { if (tentativas === 1) return null; break; }
    if (await esperarHunt(page, slug, 2000)) return { ok: true, hunt: alvo, direto: true, tentativas };
  }
  if (!forcar) throw new Error(`o jogo nao aceitou a troca para ${alvo} em ${Math.round(insistir / 1000)} s (${tentativas} pedidos; em combate sem parar)`);
  // Forcar: desistir do combate (a equipe vai ao Centro e perde 10% do XP do nivel), curar e escolher de novo
  // A equipe leva alguns segundos para chegar ao Centro; so depois o curar e a hunt nova valem. A primeira versao
  // mandava tudo em ~2 s, o jogo ignorava e a conta ficava parada no Centro: agora espera chegar, cura e insiste
  // na hunt por ate 30 s (desistir de novo custaria mais 10% do XP, entao nao repete o desistir).
  await enviar({ t: 'centro.desistir' });
  for (let i = 0; i < 40 && !((await ponte(page)) || {}).noCentro; i++) await page.waitForTimeout(500);
  const fimCentro = Date.now() + 30000;
  let curas = 0;
  while (Date.now() < fimCentro) {
    if (curas < 3) { await enviar({ t: 'centro.curar' }); curas++; await page.waitForTimeout(1500); }
    await enviar({ t: 'hunt.select', slug });
    if (await esperarHunt(page, slug, 2500)) return { ok: true, hunt: alvo, direto: true, forcado: true, perda: '10% do XP do nível', curou: true };
  }
  throw new Error(`desisti do combate, mas o jogo nao aceitou ${alvo} em 30 s (a conta ficou no Centro)`);
}

// Vai para a hunt; se o jogo recusar (combate), e forcar=true: desiste do combate (perde o XP daquela luta),
// cura no Centro se precisar e tenta de novo.
async function irPara(page, nome, nivel, forcar) {
  const direto = await irParaDireto(page, nome, nivel, forcar);
  if (direto) return direto;
  try { return await cacar(page, nome, nivel, forcar ? 20 : 45); }
  catch (e) {
    if (!forcar) throw e;
    // O jogo so troca de hunt depois de ~3 s sem dar nem tomar dano, o que nunca acontece caçando sem parar.
    // Forcar = 'Desistir do Combate' + Confirmar: a equipe vai ao Centro Pokemon e perde 10% do XP do nivel
    // (o proprio jogo mostra o valor). Depois cura e escolhe a hunt nova (no Centro a troca e aceita na hora).
    await fecharModais(page);
    const d = await page.evaluate(() => { const b = [...document.querySelectorAll('#eco-desistir, #desistir-combate')].find(x => x.getBoundingClientRect().width > 0 && !x.hidden); if (b) b.click(); return !!b; });
    if (!d) throw new Error('o jogo recusou a troca e nao achei o botao Desistir do Combate');
    await page.waitForTimeout(700);
    const perda = await page.evaluate(() => { const t = document.querySelector('.caixa-confirmar')?.innerText || ''; return (t.match(/perder[aá] ([^)]*?XP[^.]*)/i) || [])[1] || null; });
    const ok = await page.evaluate(() => { const b = [...document.querySelectorAll('.caixa-confirmar button')].find(x => x.innerText.trim() === 'Confirmar' && x.getBoundingClientRect().width > 0); if (b) b.click(); return !!b; });
    if (!ok) throw new Error('nao achei o Confirmar do Desistir do Combate');
    // espera chegar ao Centro (botao Curar aparece) e cura
    for (let i = 0; i < 20 && !(await page.locator('#centro-curar >> visible=true, #eco-curar >> visible=true').count()); i++) await page.waitForTimeout(500);
    const curou = await curarSePreciso(page);
    const r = await cacar(page, nome, nivel, 45);
    return { ...r, forcado: true, perda, curou };
  }
}

// ---- Recompra automatica (regras em config/rules.json -> restock) ----
// Estoque atual lido dos botoes do painel Automacoes (cada botao tem o nome no title e a quantidade).
function lerEstoque(page) {
  return page.evaluate(() => {
    const out = {};
    for (const b of document.querySelectorAll('#auto-corpo .auto-chip')) {
      const nome = (b.title || '').split(' — ')[0].trim();
      const q = +((b.querySelector('.q') || {}).innerText || '0').replace(/\D/g, '');
      if (nome) out[nome] = Math.max(out[nome] || 0, q);
    }
    const ck = (id) => !!document.getElementById(id)?.checked;
    return { itens: out, lancaBola: ck('auto-ball-sem-parar') || ck('auto-ball-captura') };
  });
}

const ABA = { potion: 'Poções', revive: 'Revives', ball: 'Pokebolas' };
async function abrirMarket(page, aba) {
  if (!(await page.locator('text="Comprar" >> visible=true').count())) {
    // o botao Market so aparece com a aba Menu aberta: abre o Menu antes se ele nao estiver visivel
    if (!(await page.locator('text="Market" >> visible=true').count())) {
      await clickVisible(page, TAB.menu);
      await page.locator('text="Market" >> visible=true').first().waitFor({ timeout: 5000 });
    }
    await page.locator('text="Market" >> visible=true').first().click({ timeout: 5000 });
    await page.locator('text="Comprar" >> visible=true').first().waitFor({ timeout: 8000 });
  }
  // o Market redesenha o tempo todo (o elemento "some" no meio do clique): clica direto pelo DOM, com repeticao
  // a aba e um <b> dentro do botao: clicar nele sobe ate o botao. Confere pelo titulo da secao (2a ocorrencia do nome).
  for (let i = 0; i < 4; i++) {
    const ok = await page.evaluate((aba) => {
      const b = [...document.querySelectorAll('b,button')].find(x => x.innerText?.trim() === aba && x.getBoundingClientRect().width > 0);
      if (b) b.click(); return !!b;
    }, aba);
    await page.waitForTimeout(700);
    const n = await page.evaluate((aba) => [...document.querySelectorAll('b')].filter(x => x.innerText?.trim() === aba && x.getBoundingClientRect().width > 0).length, aba);
    if (ok && n >= 2) return;
  }
  throw new Error('nao consegui abrir a aba ' + aba + ' do Market');
}
// precos dos itens visiveis no Market: "você tem ×N / Nome / ... / preco / /un."
function lerPrecos(page) {
  return page.evaluate(() => {
    const out = {};
    for (const d of document.querySelectorAll('div')) {
      const t = d.innerText || '';
      if (!t.startsWith('você tem') || t.length > 200 || !d.querySelector('input') || d.getBoundingClientRect().width === 0) continue;
      const l = t.split('\n').map(s => s.trim()).filter(Boolean);
      const k = l.indexOf('/un.');
      if (k > 1) out[l[1]] = +l[k - 1].replace(/\./g, '');
    }
    return out;
  });
}

// Precos vistos no Market ficam guardados (data/precos.json) para o painel mostrar o custo de cada item.
const PRECOS = path.join(ROOT, 'data', 'precos.json');
function guardarPrecos(p) {
  if (!p || !Object.keys(p).length) return;
  let old = {}; try { old = JSON.parse(fs.readFileSync(PRECOS, 'utf8')); } catch {}
  try { fs.writeFileSync(PRECOS, JSON.stringify({ ...old, ...p })); } catch {}
}
const tipoItem = (item) => (/Ball/.test(item) ? 'ball' : /Revive/.test(item) ? 'revive' : 'potion');

// Recompra por item (painel Automacao): accounts[acc].auto = { guardarOuro, itens: { Nome: { abaixo, ate } } }.
// Para cada item: se tiver menos que "abaixo", compra ate chegar em "ate". abaixo=0 ignora o item.
// So gasta o que passar de guardarOuro. Ordem: pocoes, revives, bolas.
async function restockItens(page, acc, auto, dry, st, itens, lancaBola) {
  let orcamento = Math.max(0, st.gold - (+auto.guardarOuro || 0));
  const ordem = { potion: 0, revive: 1, ball: 2 };
  const alvos = Object.entries(auto.itens || {})
    .map(([item, r]) => ({ item, tipo: tipoItem(item), tem: itens[item] || 0, abaixo: +r.abaixo || 0, ate: +r.ate || 0 }))
    .filter(m => m.abaixo > 0 && m.ate > m.tem && m.tem < m.abaixo)
    .sort((a, b) => ordem[a.tipo] - ordem[b.tipo]);
  const plano = [], precos = {};
  let abaAberta = null;
  for (const m of alvos) {
    if (abaAberta !== m.tipo) { await abrirMarket(page, ABA[m.tipo]); Object.assign(precos, await lerPrecos(page)); abaAberta = m.tipo; }
    const preco = precos[m.item];
    if (!preco) { plano.push({ ...m, erro: 'preco nao encontrado' }); continue; }
    const qtd = Math.min(m.ate - m.tem, Math.floor(orcamento / preco), 1000);
    if (qtd < 1) { plano.push({ tipo: m.tipo, item: m.item, tinha: m.tem, qtd: 0, preco, motivo: 'sem ouro acima do guardado' }); continue; }
    const p = { tipo: m.tipo, item: m.item, tinha: m.tem, qtd, preco, custo: qtd * preco };
    if (!dry) p.resultado = await buy(page, m.item, qtd);
    orcamento -= p.custo; plano.push(p);
  }
  guardarPrecos(precos);
  return plano;
}

// Planeja e (se dry=false) executa a recompra de uma conta.
async function restock(page, acc, regras, dry) {
  const st = parseStatus(await page.evaluate(() => document.body.innerText), acc);
  if (!st.loggedIn || st.gold == null) throw new Error('nao consegui ler o ouro da conta');
  const { itens, lancaBola } = await lerEstoque(page);
  const R = regras.restock || {}, conta = (regras.accounts || {})[acc] || {};
  if (conta.auto && conta.auto.itens) {
    const compras = await restockItens(page, acc, conta.auto, dry, st, itens, lancaBola);
    if (await page.locator('text="Comprar" >> visible=true').count()) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.locator('.modal-fechar >> visible=true, button[title="Fechar"] >> visible=true').first().click({ timeout: 1500 }).catch(() => {});
    }
    const depois = dry ? null : parseStatus(await page.evaluate(() => document.body.innerText), acc).gold;
    return { conta: acc, ouroAntes: st.gold, ouroDepois: depois, estoque: itens, lancaBola, compras, simulacao: !!dry, regra: 'itens' };
  }
  const reserva = R.reservaOuro || 0;
  let orcamento = Math.max(0, Math.min(Math.floor(st.gold * (regras.maxGoldSpendPct || 75) / 100), st.gold - reserva));
  const pocao = conta.potion || (regras.potion || {}).type || 'Great Potion';
  const bola = conta.ball || R.ball || 'Ultra Ball';
  const metas = [
    { tipo: 'potion', item: pocao, tem: itens[pocao] || 0, alvo: conta.potionStock || (regras.potion || {}).targetStock || 300, gatilho: R.potionMin ?? 100 },
    { tipo: 'revive', item: 'Revive', tem: itens['Revive'] || 0, alvo: (regras.revive || {}).targetStock || 10, gatilho: R.reviveMin ?? 5 },
    // bola so para quem lanca bola sozinho (VIP); "com o que sobrar", no minimo ultraBall.minAfterBuy
    { tipo: 'ball', item: bola, tem: itens[bola] || 0, alvo: Infinity, gatilho: lancaBola ? ((regras.ultraBall || {}).minAfterBuy ?? 150) : -1 },
  ];
  const ordem = (regras.buyOrder || ['potion', 'revive', 'ultraBall']).map(x => (x === 'ultraBall' ? 'ball' : x));
  const plano = [];
  const precos = {};
  for (const tipo of ordem) {
    const m = metas.find(x => x.tipo === tipo);
    if (!m || m.tem >= m.gatilho) continue; // ainda tem estoque: nao compra
    if (!dry || !precos[m.item]) { await abrirMarket(page, ABA[tipo]); Object.assign(precos, await lerPrecos(page)); guardarPrecos(precos); }
    const preco = precos[m.item];
    if (!preco) { plano.push({ ...m, erro: 'preco nao encontrado' }); continue; }
    let qtd = m.alvo === Infinity ? Math.floor(orcamento / preco) : Math.max(0, m.alvo - m.tem);
    qtd = Math.min(qtd, Math.floor(orcamento / preco), 1000);
    if (qtd < 1) { plano.push({ ...m, preco, qtd: 0, motivo: 'sem orcamento' }); continue; }
    const p = { tipo, item: m.item, tinha: m.tem, qtd, preco, custo: qtd * preco };
    if (!dry) p.resultado = await buy(page, m.item, qtd);
    orcamento -= p.custo; plano.push(p);
  }
  if (await page.locator('text="Comprar" >> visible=true').count()) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('.modal-fechar >> visible=true, button[title="Fechar"] >> visible=true').first().click({ timeout: 1500 }).catch(() => {});
  }
  const depois = dry ? null : parseStatus(await page.evaluate(() => document.body.innerText), acc).gold;
  return { conta: acc, ouroAntes: st.gold, ouroDepois: depois, estoque: itens, lancaBola, compras: plano, simulacao: !!dry };
}

// Economia de maquina para conta que voce NAO esta olhando:
// - pausa as animacoes CSS infinitas (brilhos/pulsos de banner) que obrigam a pagina a redesenhar 60x/s mesmo com a
//   cena desligada (medido: ~10% -> ~3% de CPU por conta). Animacoes finitas e transicoes ficam intactas.
// - liga o "Modo Economia" do proprio jogo (cena desligada, a caca continua no servidor do jogo) so quando `ligarCena`
//   pede (na troca de foco), para respeitar se voce religar a cena na mao.
// on=false (conta em foco): volta as animacoes e, se fomos nos que ligamos o Modo Economia, liga a cena de novo.
function economiaScript({ on, jogo }) {
  const W = window;
  const set = (W.__pbPaused ||= new Set());
  const vis = (e) => e && e.offsetParent !== null && !e.classList.contains('hidden');
  let pausadas = 0, acao = null;
  if (on) {
    for (const a of document.getAnimations()) {
      try {
        if (a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations === Infinity) { a.pause(); set.add(a); pausadas++; }
      } catch {}
    }
    for (const a of [...set]) { const t = a.effect && a.effect.target; if (!t || !t.isConnected) set.delete(a); }
    if (jogo && localStorage.getItem('cfg-economia') !== '1') {
      const b = document.getElementById('hunt-eco');
      if (vis(b)) { b.click(); W.__pbEcoAuto = true; acao = 'modo economia ligado'; }
    }
  } else {
    for (const a of set) { try { a.play(); } catch {} }
    set.clear();
    if (jogo && W.__pbEcoAuto && localStorage.getItem('cfg-economia') === '1') {
      const b = document.getElementById('eco-sair');
      const b2 = document.getElementById('hunt-eco');
      if (vis(b)) b.click(); else if (vis(b2)) b2.click();
      acao = 'cena religada';
    }
    if (jogo) W.__pbEcoAuto = false;
  }
  return { eco: localStorage.getItem('cfg-economia') === '1', pausadas, acao };
}

const TAB = { equipe: 'Equipe', mochila: 'Mochila', auto: 'Auto', chat: 'Chat', menu: 'Menu' };

const actions = {
  async open({ acc }) { await open(acc); return 'ok'; },
  async openall({ accs }) {
    const out = {};
    for (const a of (accs || Object.keys(PORTS).join(',')).split(',')) {
      out[a] = await open(a).then(() => 'conectada', e => String(e.message || e));
    }
    return out;
  },
  async accounts() { return Object.keys(ctxs); },
  mode() { return MODE; },
  async text({ acc }) { return (await open(acc)).page.evaluate(() => document.body.innerText); },
  async economia({ acc, on, jogo }) {
    const b = (v) => v === true || v === 'true' || v === '1' || v === 1;
    return (await open(acc)).page.evaluate(economiaScript, { on: b(on), jogo: b(jogo) });
  },
  async status({ acc }) { return parseStatus(await (await open(acc)).page.evaluate(() => document.body.innerText), acc); },
  async shot({ acc, file }) {
    const f = path.resolve(file || path.join(ROOT, 'data', `shot-${acc}.png`));
    await (await open(acc)).page.screenshot({ path: f }); return f;
  },
  async click({ acc, text, selector, x, y }) {
    const { page } = await open(acc);
    if (selector) await page.click(selector);
    else if (text) await clickVisible(page, text);
    else await page.mouse.click(+x, +y);
    return 'ok';
  },
  async tab({ acc, name }) { await clickVisible((await open(acc)).page, TAB[name] || name); return 'ok'; },
  async scroll({ acc, dy }) {
    const { page } = await open(acc);
    return page.evaluate((dy) => {
      const e = [...document.querySelectorAll('*')].filter(x => x.scrollHeight > x.clientHeight + 20 && x.clientHeight > 50 && x.clientWidth < 600);
      e.forEach(x => (x.scrollTop += +dy)); return e.length;
    }, dy || 250);
  },
  async ficha({ acc }) { return ficha((await open(acc)).page); },
  async hunt({ acc, sorts }) {
    const t0 = Date.now();
    const { page } = await open(acc);
    const tela = await page.evaluate(() => document.body.innerText);
    const st = parseStatus(tela, acc);
    if (!st.loggedIn || !st.level) throw new Error('nao consegui ler o nivel do treinador (conta logada?)');
    const dia = tipoDoDia(tela);
    const txt = await ficha(page);
    await page.keyboard.press('Escape').catch(() => {}); // fecha a ficha
    await fecharModais(page);
    let regras = {}; try { regras = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'rules.json'), 'utf8')).hunt || {}; } catch {}
    const r = await huntRank(txt, st.level, (sorts || 'XP/h,Ouro/h,Shiny/h').split(','), { dia, bola: regras.bola || 4 });
    return {
      conta: acc, nivelTreinador: st.level, tipoDoDia: dia || null, huntAtual: st.hunt,
      pokemon: (txt.split('\n')[0] || '').replace(/^# /, '').replace(/ — ficha do PokeIdle$/, ''),
      ranking: r, recomendacao: recomendar(r, regras.riscoMax ?? 30), segundos: Math.round((Date.now() - t0) / 100) / 10,
    };
  },
  async cacar({ acc, nome, nivel, espera, forcar }) {
    const { page } = await open(acc);
    if (forcar === '1' || forcar === 'true' || forcar === true) return irPara(page, nome, +nivel, true);
    return (await irParaDireto(page, nome, +nivel, false)) || cacar(page, nome, +nivel, +espera || 45);
  },
  // ponte do deck: estado (hunt atual, Centro) e a lista de hunts do jogo; null = sem a ponte (PokeBot.exe)
  async ponte({ acc, lista }) {
    const { page } = await open(acc);
    const e = await ponte(page);
    if (!e || !(lista === true || lista === '1')) return e;
    return { ...e, lista: await page.evaluate(() => window.__pokebot.hunts()) };
  },
  // Deixa a conta pronta e na melhor hunt: cura se estiver no Centro, poe o principal em campo,
  // analisa (ficha -> pokeidleguide) e vai para a melhor hunt segura do criterio (forcando se o jogo recusar).
  async irMelhor({ acc, crit, forcar }) {
    const { page } = await open(acc);
    const curou = await curarSePreciso(page);
    const principal = await garantirPrincipal(page);
    const analise = await actions.hunt({ acc });
    const c = crit || 'XP/h';
    const m = analise.recomendacao[c] && analise.recomendacao[c].melhor;
    if (!m) throw new Error('nenhuma hunt segura para ' + c);
    // Forcar custa 10% do XP do nivel: so vale se a hunt nova render bem mais que a atual (rules.hunt.ganhoMinForcarPct)
    let regras = {}; try { regras = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'rules.json'), 'utf8')).hunt || {}; } catch {}
    const minPct = regras.ganhoMinForcarPct ?? 5;
    const atual = (analise.huntAtual || '').match(/^(.*) · nível (\d+)$/);
    const rowAtual = atual && (analise.ranking[c] || []).map(rowObj).find(o => o.pokemon === atual[1] && o.nivel === +atual[2]);
    const ganhoPct = rowAtual && rowAtual.valorNum ? Math.round((m.valorNum / rowAtual.valorNum - 1) * 1000) / 10 : null;
    let pode = !(forcar === '0' || forcar === false);
    if (pode && ganhoPct != null && ganhoPct < minPct) pode = false; // nao compensa perder XP por tao pouco
    try {
      const ida = await irPara(page, m.pokemon, m.nivel, pode);
      return { conta: acc, curou, principal, alvo: `${m.pokemon} Nv ${m.nivel} (${m.valor})`, ganhoPct, ida, analise };
    } catch (e) {
      if (!pode && ganhoPct != null) return { conta: acc, curou, principal, alvo: `${m.pokemon} Nv ${m.nivel} (${m.valor})`, ganhoPct,
        ida: { ficou: true, motivo: `em combate; a nova rende só +${ganhoPct}% (forço a partir de +${minPct}%)` }, analise };
      throw e;
    }
  },
  // So analisa (nao troca): melhor hunt segura do criterio x hunt atual, com o ganho em %.
  async avaliarHunt({ acc, crit }) {
    const analise = await actions.hunt({ acc });
    const c = crit || 'XP/h';
    const m = analise.recomendacao[c] && analise.recomendacao[c].melhor;
    if (!m) throw new Error('nenhuma hunt segura para ' + c);
    const atual = (analise.huntAtual || '').match(/^(.*) · nível (\d+)$/);
    const jaEsta = !!atual && atual[1] === m.pokemon && +atual[2] === m.nivel;
    const rowAtual = atual && (analise.ranking[c] || []).map(rowObj).find(o => o.pokemon === atual[1] && o.nivel === +atual[2]);
    const ganhoPct = rowAtual && rowAtual.valorNum ? Math.round((m.valorNum / rowAtual.valorNum - 1) * 1000) / 10 : null;
    return { conta: acc, crit: c, alvo: `${m.pokemon} Nv ${m.nivel} (${m.valor})`, atual: analise.huntAtual || null, ganhoPct, jaEsta, analise };
  },
  async estoque({ acc }) { return lerEstoque((await open(acc)).page); },
  async restock({ acc, dry }) {
    let regras = {}; try { regras = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'rules.json'), 'utf8')); } catch {}
    return restock((await open(acc)).page, acc, regras, dry === true || dry === 'true' || dry === '1');
  },
  async buy({ acc, item, qty }) { return buy((await open(acc)).page, item, qty); },
  async type({ acc, text }) { await (await open(acc)).page.keyboard.type(text); return 'ok'; },
  async key({ acc, key }) { await (await open(acc)).page.keyboard.press(key); return 'ok'; },
  async eval({ acc, code }) { return (await open(acc)).page.evaluate(code); },
  async home({ acc }) { const { page } = await open(acc); await page.goto(URL_GAME).catch(() => {}); return page.url(); },
  async reload({ acc }) { await (await open(acc)).page.reload(); return 'ok'; },
  // No app, fechar = so desconectar o motor (a conta continua na janela do PokeBot).
  async close({ acc }) { delete ctxs[acc]; return 'motor desconectado de ' + acc; },
};

module.exports = { actions, open, parseStatus, ctxs, PORTS, CONTAS };
