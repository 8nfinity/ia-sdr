import Database from 'libsql';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uid, nowIso } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR: sem Turso, e onde o arquivo SQLite vive (idealmente um volume
// persistente). Com Turso, e so o cache local da replica - pode sumir a
// vontade, a fonte da verdade e o Turso.
const dataDir = process.env.DATA_DIR || path.join(here, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const bancoEm = path.join(dataDir, 'iasdr.db');

/**
 * Com TURSO_DATABASE_URL + TURSO_AUTH_TOKEN definidos, o banco vira uma
 * "embedded replica": leituras saem do arquivo local (rapidas), e TODA
 * escrita e enviada na hora para o Turso (write-through - o dado so e
 * "gravado" quando o Turso confirma). Deploy nao encosta mais nos dados:
 * o container e descartavel, o Turso guarda tudo.
 * Sem as variaveis, cai no SQLite local de sempre (dev, ou volume).
 */
export const usandoTurso = Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
export const db = usandoTurso
  ? new Database(bancoEm, {
      syncUrl: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
      syncInterval: 60, // segundos: puxa mudancas feitas por outros clientes/dashboard
    })
  : new Database(bancoEm);

// Puxa o estado atual do Turso ANTES de criar tabelas: numa replica novinha
// (container recem-criado no deploy) e isso que traz de volta todos os dados.
//
// Se o Turso estiver inacessivel, NAO adianta continuar: com "embedded
// replica" toda escrita e delegada ao primario, entao ate o CREATE TABLE
// abaixo falharia. Melhor parar com uma mensagem clara do que subir num
// estado quebrado (ou pior, num banco local vazio fingindo que esta tudo bem).
if (usandoTurso) {
  let ok = false;
  for (let tentativa = 1; tentativa <= 4 && !ok; tentativa++) {
    try {
      db.sync();
      ok = true;
    } catch (err) {
      if (tentativa === 4) {
        console.error('');
        console.error('  ================================================================');
        console.error('  NAO CONSEGUI FALAR COM O TURSO.');
        console.error('  ================================================================');
        console.error(`  Erro: ${err.message}`);
        console.error('');
        console.error('  Confira TURSO_DATABASE_URL (comeca com libsql://) e');
        console.error('  TURSO_AUTH_TOKEN nas variaveis de ambiente. Gere um token novo');
        console.error('  com:  turso db tokens create <seu-banco>');
        console.error('');
        process.exit(1);
      }
      const espera = tentativa * 2000;
      console.error(`  [db] Turso nao respondeu (tentativa ${tentativa}/4). Tentando de novo em ${espera / 1000}s...`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  console.log('  [db] replica sincronizada com o Turso.');
}

try { db.exec('PRAGMA journal_mode = WAL;'); } catch { /* replica gerencia o journal */ }

db.exec(`
CREATE TABLE IF NOT EXISTS searches (
  id TEXT PRIMARY KEY, segment TEXT, region TEXT, quantity INTEGER,
  status TEXT, source TEXT, log TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY, search_id TEXT, name TEXT, phone TEXT, phone_e164 TEXT,
  website TEXT, domain TEXT, instagram TEXT, email TEXT, address TEXT,
  rating REAL, reviews INTEGER, category TEXT, maps_url TEXT, source TEXT,
  score INTEGER, verdict TEXT, reasons TEXT, notes TEXT,
  cnpj TEXT, razao_social TEXT, situacao TEXT, decisor TEXT, socios TEXT, phone_receita TEXT,
  celular_responsavel TEXT, tipo_telefone TEXT,
  status TEXT DEFAULT 'novo', created_at TEXT
);
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY, name TEXT, status TEXT, conference TEXT,
  agent_phone TEXT, winner_call_id TEXT, winner_company_id TEXT,
  script TEXT, mode TEXT, modo TEXT, agent_call_sid TEXT, created_at TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY, campaign_id TEXT, company_id TEXT, to_number TEXT,
  provider_sid TEXT, status TEXT, answered_by TEXT, is_winner INTEGER DEFAULT 0,
  agent_state TEXT DEFAULT 'idle', transcript TEXT, outcome TEXT,
  created_at TEXT, answered_at TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, company_id TEXT, phone TEXT, direction TEXT,
  channel TEXT, body TEXT, provider_id TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS pagamentos_mp (
  id TEXT PRIMARY KEY, user_id TEXT, tipo TEXT, valor_centavos INTEGER,
  status TEXT, mp_id TEXT, external_reference TEXT, detalhe TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pagamentos_mp_id ON pagamentos_mp(mp_id);
CREATE TABLE IF NOT EXISTS reunioes (
  id TEXT PRIMARY KEY, user_id TEXT, company_id TEXT, campaign_id TEXT,
  quando TEXT, duracao_min INTEGER DEFAULT 30, titulo TEXT, notas TEXT,
  status TEXT DEFAULT 'agendada',
  crm_provider TEXT, crm_external_id TEXT, crm_url TEXT, crm_status TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reunioes_user ON reunioes(user_id);
CREATE INDEX IF NOT EXISTS idx_reunioes_company ON reunioes(company_id);
CREATE TABLE IF NOT EXISTS uso (
  id TEXT PRIMARY KEY, tipo TEXT, ref_id TEXT, modelo TEXT,
  entrada INTEGER, saida INTEGER, cache INTEGER, buscas INTEGER,
  usd REAL, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_uso_data ON uso(created_at);
CREATE INDEX IF NOT EXISTS idx_companies_search ON companies(search_id);
CREATE INDEX IF NOT EXISTS idx_calls_campaign ON calls(campaign_id);
CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
`);

// Tabelas cujos registros pertencem a um usuário. O dono é carimbado
// automaticamente no insert: assim nenhuma parte do sistema pode esquecer de
// marcar quem é o dono e acabar misturando dados de clientes diferentes.
const TABELAS_COM_DONO = new Set([
  'searches', 'companies', 'campaigns', 'calls', 'messages', 'uso', 'wa_fila', 'reunioes',
]);

let donoAtual = () => null;
export const definirDonoAtual = (fn) => { donoAtual = fn; };

const cols = (obj) => Object.keys(obj);
export function insert(table, row) {
  if (TABELAS_COM_DONO.has(table) && row.user_id === undefined) {
    const dono = donoAtual();
    if (dono) row = { ...row, user_id: dono };
  }
  const keys = cols(row);
  const stmt = db.prepare(
    `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  );
  stmt.run(...keys.map((k) => row[k] ?? null));
  return row;
}
export function update(table, id, patch) {
  const keys = cols(patch);
  if (!keys.length) return;
  db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`)
    .run(...keys.map((k) => patch[k] ?? null), id);
}
// O driver do libsql cola um campo "_metadata" em cada linha. Inofensivo,
// mas polui as respostas JSON da API - tira aqui, na fonte.
const semMeta = (r) => {
  if (r && typeof r === 'object' && '_metadata' in r) delete r._metadata;
  return r;
};
export const one = (sql, ...params) => semMeta(db.prepare(sql).get(...params)) ?? null;
export const many = (sql, ...params) => db.prepare(sql).all(...params).map(semMeta);

// ---------- helpers de dominio ----------

export function saveCompany(searchId, c) {
  const row = {
    id: uid('cmp_'),
    search_id: searchId,
    name: c.name,
    phone: c.phone ?? null,
    phone_e164: c.phoneE164 ?? null,
    website: c.website ?? null,
    domain: c.domain ?? null,
    instagram: c.instagram ?? null,
    email: c.email ?? null,
    address: c.address ?? null,
    rating: c.rating ?? null,
    reviews: c.reviews ?? null,
    category: c.category ?? null,
    maps_url: c.mapsUrl ?? null,
    source: c.source ?? null,
    score: c.score ?? null,
    verdict: c.verdict ?? null,
    reasons: JSON.stringify(c.reasons ?? []),
    notes: c.notes ?? null,
    cnpj: c.cnpj ?? null,
    razao_social: c.razaoSocial ?? null,
    situacao: c.situacao ?? null,
    decisor: c.decisor ?? null,
    socios: c.socios ? JSON.stringify(c.socios) : null,
    phone_receita: c.phoneReceita ?? null,
    celular_responsavel: c.celularResponsavel ?? c.celularPublicado ?? null,
    tipo_telefone: c.tipoTelefone ?? null,
    status: 'novo',
    created_at: nowIso(),
  };
  insert('companies', row);
  return row;
}

export const getCompany = (id) => one('SELECT * FROM companies WHERE id=?', id);
export const listCompanies = (searchId) =>
  many('SELECT * FROM companies WHERE search_id=? ORDER BY score DESC, name ASC', searchId);

export function companyByPhone(phoneE164) {
  if (!phoneE164) return null;
  const tail = phoneE164.replace(/\D/g, '').slice(-8);
  return one(
    "SELECT * FROM companies WHERE replace(replace(replace(replace(coalesce(phone_e164,''),'+',''),'-',''),' ',''),'(','') LIKE ? ORDER BY created_at DESC LIMIT 1",
    '%' + tail
  );
}

/**
 * Reivindica, de forma atomica, o vencedor da corrida de ligacoes.
 * Retorna true apenas para a PRIMEIRA chamada atendida da campanha.
 */
export function claimWinner(campaignId, callId, companyId) {
  const res = db
    .prepare('UPDATE campaigns SET winner_call_id=?, winner_company_id=?, status=? WHERE id=? AND winner_call_id IS NULL')
    .run(callId, companyId, 'conectada', campaignId);
  return Number(res.changes) === 1;
}

/** Bancos criados antes do medidor de custo ganham as colunas que faltam. */
export function migrar() {
  const colunas = many('PRAGMA table_info(searches)').map((c) => c.name);
  const cCamp = many('PRAGMA table_info(campaigns)').map((c) => c.name);
  if (!cCamp.includes('agent_call_sid')) db.exec('ALTER TABLE campaigns ADD COLUMN agent_call_sid TEXT');
  if (!cCamp.includes('modo')) db.exec('ALTER TABLE campaigns ADD COLUMN modo TEXT');
  // Coluna do dono em todas as tabelas de dados (bancos antigos incluídos).
  for (const t of ['searches', 'companies', 'campaigns', 'calls', 'messages', 'uso', 'wa_fila']) {
    try {
      const colunasT = many(`PRAGMA table_info(${t})`).map((c) => c.name);
      if (colunasT.length && !colunasT.includes('user_id')) {
        db.exec(`ALTER TABLE ${t} ADD COLUMN user_id TEXT`);
      }
    } catch { /* tabela ainda nao existe */ }
  }

  const cEmp = many('PRAGMA table_info(companies)').map((c) => c.name);
  for (const [col, tipo] of [
    ['cnpj', 'TEXT'], ['razao_social', 'TEXT'], ['situacao', 'TEXT'],
    ['decisor', 'TEXT'], ['socios', 'TEXT'], ['phone_receita', 'TEXT'], ['celular_responsavel', 'TEXT'], ['tipo_telefone', 'TEXT'],
    // Gravacao/transcricao/resumo da ligacao vencedora, copiados para a
    // empresa (nao so para a chamada) porque e a empresa que vai pro CRM.
    ['gravacao_url', 'TEXT'], ['transcricao_texto', 'TEXT'], ['resumo_ligacao', 'TEXT'],
  ]) {
    if (!cEmp.includes(col)) db.exec('ALTER TABLE companies ADD COLUMN ' + col + ' ' + tipo);
  }
  if (!colunas.includes('custo_usd')) {
    db.exec('ALTER TABLE searches ADD COLUMN custo_usd REAL');
    db.exec('ALTER TABLE searches ADD COLUMN uso TEXT');
  }

  const cCalls = many('PRAGMA table_info(calls)').map((c) => c.name);
  for (const [col, tipo] of [
    ['recording_sid', 'TEXT'], ['recording_url', 'TEXT'],
    ['transcript_sid', 'TEXT'], ['transcricao_status', 'TEXT'],
  ]) {
    if (cCalls.length && !cCalls.includes(col)) db.exec('ALTER TABLE calls ADD COLUMN ' + col + ' ' + tipo);
  }

  // Assinatura/plano: a tabela usuarios pertence a usuarios.js, que pode
  // ainda nao ter rodado seu CREATE TABLE quando este migrar() executa
  // (depende de quem importou quem primeiro) - por isso o try/catch, igual
  // ja se faz acima para user_id.
  try {
    const cUsu = many('PRAGMA table_info(usuarios)').map((c) => c.name);
    for (const [col, tipo] of [
      ['plano', 'TEXT'], ['assinatura_status', "TEXT DEFAULT 'nenhuma'"], ['assinatura_id_mp', 'TEXT'],
      ['periodo_inicio', 'TEXT'], ['periodo_fim', 'TEXT'],
      ['creditos_buscas', 'INTEGER DEFAULT 0'], ['creditos_ligacoes', 'INTEGER DEFAULT 0'],
    ]) {
      if (cUsu.length && !cUsu.includes(col)) db.exec('ALTER TABLE usuarios ADD COLUMN ' + col + ' ' + tipo);
    }
  } catch { /* usuarios.js ainda nao criou a tabela - roda na proxima chamada */ }
}

/** Grava uma chamada de API e devolve o custo em dolares. */
export function registrarUso(u) {
  insert('uso', {
    id: uid('uso_'),
    tipo: u.tipo ?? 'avulso',
    ref_id: u.refId ?? null,
    modelo: u.modelo ?? null,
    entrada: u.entrada ?? 0,
    saida: u.saida ?? 0,
    cache: u.cache ?? 0,
    buscas: u.buscas ?? 0,
    usd: u.usd ?? 0,
    created_at: nowIso(),
  });
}

/** Totais de gasto do usuario da vez (ou de todos, se for admin). */
export function resumoDeCustos(userId = null) {
  const hoje = new Date().toISOString().slice(0, 10);
  const filtro = userId ? ' AND user_id=?' : '';
  const p = userId ? [userId] : [];
  const total = (sql, ...args) => one(sql, ...args) ?? {};
  return {
    hoje: total(
      `SELECT COALESCE(SUM(usd),0) usd, COUNT(*) chamadas FROM uso WHERE substr(created_at,1,10)=?${filtro}`,
      hoje,
      ...p
    ),
    total: total(`SELECT COALESCE(SUM(usd),0) usd, COUNT(*) chamadas FROM uso WHERE 1=1${filtro}`, ...p),
    porTipo: many(
      `SELECT tipo, COUNT(*) chamadas, COALESCE(SUM(usd),0) usd, COALESCE(SUM(buscas),0) buscas
       FROM uso WHERE 1=1${filtro} GROUP BY tipo ORDER BY usd DESC`,
      ...p
    ),
    ultimasBuscas: many(
      `SELECT ref_id, COALESCE(SUM(usd),0) usd, COALESCE(SUM(buscas),0) buscas
       FROM uso WHERE tipo='busca'${filtro} GROUP BY ref_id ORDER BY MAX(created_at) DESC LIMIT 10`,
      ...p
    ),
  };
}

/** Quanto o usuario ja gastou (usado para o limite de gasto). */
export const gastoDoUsuario = (userId) =>
  one('SELECT COALESCE(SUM(usd),0) usd FROM uso WHERE user_id=?', userId)?.usd ?? 0;

/**
 * Painel de resultados do CLIENTE: o funil de prospeccao dele no periodo.
 * userId nulo = visao geral (admin). dias = 0 significa "desde sempre".
 */
export function metricasCliente(userId = null, dias = 30) {
  const desde = dias > 0 ? new Date(Date.now() - dias * 86400000).toISOString() : '0000';
  const fU = userId ? ' AND user_id=?' : '';
  const pU = userId ? [userId] : [];
  const n = (sql, ...args) => one(sql, ...args)?.v ?? 0;

  const funil = {
    buscas: n(
      `SELECT COUNT(*) v FROM searches WHERE created_at>=?${fU} AND (source IS NULL OR source<>'planilha')`,
      desde, ...pU
    ),
    leads: n(`SELECT COUNT(*) v FROM companies WHERE created_at>=?${fU}`, desde, ...pU),
    leadsSalvos: n(`SELECT COUNT(*) v FROM companies WHERE created_at>=?${fU} AND status<>'novo'`, desde, ...pU),
    ligacoes: n(`SELECT COUNT(*) v FROM calls WHERE created_at>=?${fU}`, desde, ...pU),
    atenderam: n(`SELECT COUNT(*) v FROM calls WHERE created_at>=?${fU} AND is_winner=1`, desde, ...pU),
    caixaPostal: n(`SELECT COUNT(*) v FROM calls WHERE created_at>=?${fU} AND status='voicemail'`, desde, ...pU),
    reunioes: n(`SELECT COUNT(*) v FROM reunioes WHERE created_at>=?${fU} AND status<>'cancelada'`, desde, ...pU),
    reunioesRealizadas: n(`SELECT COUNT(*) v FROM reunioes WHERE created_at>=?${fU} AND status='realizada'`, desde, ...pU),
  };
  funil.naoAtenderam = Math.max(0, funil.ligacoes - funil.atenderam - funil.caixaPostal);

  const porDia = many(
    `SELECT substr(created_at,1,10) dia, COUNT(*) ligacoes,
       SUM(CASE WHEN is_winner=1 THEN 1 ELSE 0 END) atenderam
     FROM calls WHERE created_at>=?${fU} GROUP BY dia ORDER BY dia`,
    desde, ...pU
  );

  const porResultado = many(
    `SELECT status, COUNT(*) total FROM companies
     WHERE created_at>=?${fU} AND status NOT IN ('novo','lead') GROUP BY status ORDER BY total DESC`,
    desde, ...pU
  );

  // Proximas reunioes (do periodo pra frente, ainda nao realizadas).
  const fUR = userId ? ' AND r.user_id=?' : '';
  const proximasReunioes = many(
    `SELECT r.id, r.quando, r.duracao_min, r.titulo, r.status, r.crm_url,
       (SELECT name FROM companies WHERE id=r.company_id) empresa,
       (SELECT phone_e164 FROM companies WHERE id=r.company_id) telefone
     FROM reunioes r
     WHERE r.status='agendada'${fUR} ORDER BY r.quando ASC LIMIT 30`,
    ...pU
  );

  return { periodoDias: dias, funil, porDia, porResultado, proximasReunioes };
}

/** Painel do administrador: um retrato de cada usuario e do sistema. */
export function metricasAdmin() {
  const hoje = new Date().toISOString().slice(0, 10);
  const mes = new Date().toISOString().slice(0, 7);

  const porUsuario = many(`
    SELECT u.id, u.nome, u.email, u.papel, u.status, u.limite_usd, u.created_at, u.ultimo_acesso,
      u.plano, u.assinatura_status, u.periodo_inicio, u.periodo_fim,
      u.creditos_buscas, u.creditos_ligacoes,
      (SELECT COALESCE(SUM(usd),0) FROM uso WHERE user_id=u.id) AS gasto_total,
      (SELECT COALESCE(SUM(usd),0) FROM uso WHERE user_id=u.id AND substr(created_at,1,7)=?) AS gasto_mes,
      (SELECT COUNT(*) FROM searches WHERE user_id=u.id) AS buscas,
      (SELECT COUNT(*) FROM companies WHERE user_id=u.id) AS leads,
      (SELECT COUNT(*) FROM campaigns WHERE user_id=u.id) AS campanhas,
      (SELECT COUNT(*) FROM calls WHERE user_id=u.id) AS ligacoes,
      (SELECT COUNT(*) FROM calls WHERE user_id=u.id AND is_winner=1) AS atendidas,
      (SELECT COUNT(*) FROM searches WHERE user_id=u.id AND created_at>=COALESCE(u.periodo_inicio,u.created_at)
        AND (source IS NULL OR source<>'planilha')) AS buscas_ciclo,
      (SELECT COUNT(*) FROM calls WHERE user_id=u.id AND created_at>=COALESCE(u.periodo_inicio,u.created_at)) AS ligacoes_ciclo
    FROM usuarios u ORDER BY gasto_total DESC
  `, mes);

  const num = (sql, ...p) => one(sql, ...p) ?? {};
  return {
    usuarios: porUsuario,
    totais: {
      usuarios: porUsuario.length,
      ativos: porUsuario.filter((u) => u.status === 'ativo').length,
      gastoHoje: num("SELECT COALESCE(SUM(usd),0) v FROM uso WHERE substr(created_at,1,10)=?", hoje).v,
      gastoMes: num("SELECT COALESCE(SUM(usd),0) v FROM uso WHERE substr(created_at,1,7)=?", mes).v,
      gastoTotal: num('SELECT COALESCE(SUM(usd),0) v FROM uso').v,
      buscas: num('SELECT COUNT(*) v FROM searches').v,
      leads: num('SELECT COUNT(*) v FROM companies').v,
      ligacoes: num('SELECT COUNT(*) v FROM calls').v,
      atendidas: num('SELECT COUNT(*) v FROM calls WHERE is_winner=1').v,
      mensagens: num('SELECT COUNT(*) v FROM messages').v,
    },
    // Gasto e atividade dos ultimos 14 dias, para o grafico.
    porDia: many(`
      SELECT substr(created_at,1,10) dia, COALESCE(SUM(usd),0) usd, COUNT(*) chamadas
      FROM uso GROUP BY dia ORDER BY dia DESC LIMIT 14
    `).reverse(),
    porTipo: many(
      'SELECT tipo, COUNT(*) chamadas, COALESCE(SUM(usd),0) usd FROM uso GROUP BY tipo ORDER BY usd DESC'
    ),
  };
}

migrar();

export const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
export const getSetting = (key, def = null) => {
  const row = one('SELECT value FROM settings WHERE key=?', key);
  if (!row) return def;
  try { return JSON.parse(row.value); } catch { return def; }
};
