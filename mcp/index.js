// Conector MCP stdio (Claude Code, Grok CLI): todas as ferramentas, falando com a API local do PokeBot.
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { criarServidor } = require('./tools');

const BASE = 'http://127.0.0.1:8787/';
const call = async (p, params = {}, body) => {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(BASE + p + (q ? '?' + q : ''), body ? { method: 'POST', body } : undefined);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.result;
};

criarServidor(call, { completo: true }).connect(new StdioServerTransport());
