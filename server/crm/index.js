/**
 * Registro dos CRMs suportados e orquestracao do envio.
 */
import { db, insert, update, one, many } from '../db.js';
import { uid, nowIso } from '../util.js';
import { log, emit } from '../realtime.js';
import { encriptar, decriptar, mascarar } from './crypto.js';
import { pipedrive } from './pipedrive.js';
import { hubspot } from './hubspot.js';
import { webhook } from './webhook.js';

db.exec(`
CREATE TABLE IF NOT EXISTS crm_integracoes (
  id TEXT PRIMARY KEY, user_id TEXT, provider TEXT, config_enc TEXT,
  ativo INTEGER DEFAULT 1, auto_sync INTEGER DEFAULT 0, auto_reuniao INTEGER DEFAULT 0,
  ultimo_erro TEXT, ultima_sincronizacao TEXT, created_at TEXT,
  UNIQUE(user_id, provider)
);
CREATE TABLE IF NOT EXISTS crm_sincronizacoes (
  id TEXT PRIMARY KEY, company_id TEXT, user_id TEXT, provider TEXT,
  external_id TEXT, external_url TEXT, status TEXT, erro TEXT, synced_at TEXT,
  UNIQUE(company_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_crm_sinc_company ON crm_sincronizacoes(company_id);
`);
// Banco antigo: adiciona a coluna nova sem quebrar.
try {
  const cols = many('PRAGMA table_info(crm_integracoes)').map((c) => c.name);
  if (!cols.includes('auto_reuniao')) db.exec('ALTER TABLE crm_integracoes ADD COLUMN auto_reuniao INTEGER DEFAULT 0');
} catch { /* tabela recem criada ja tem a coluna */ }

export const PROVEDORES = { pipedrive, hubspot, webhook };
export const listarProvedores = () =>
  Object.values(PROVEDORES).map((p) => ({ nome: p.nome, rotulo: p.rotulo, campos: p.campos }));

const lerConfig = (row) => JSON.parse(decriptar(row.config_enc) ?? '{}');

/**
 * Resolve os campos que o cliente mandou "em branco" ou com a mascara
 * (••••1234) usando o valor ja salvo. Sem isso, salvar uma integracao sem
 * mexer no campo da chave gravaria a mascara por cima da chave de verdade -
 * a integracao pareceria conectada e toda sincronizacao falharia.
 */
export function resolverConfig(userId, provider, parcial) {
  const row = one('SELECT config_enc FROM crm_integracoes WHERE user_id=? AND provider=?', userId, provider);
  const atual = row ? lerConfig(row) : {};
  const resolvido = { ...parcial };
  for (const chave of Object.keys(resolvido)) {
    const v = resolvido[chave];
    if (!v || /^••••/.test(v)) resolvido[chave] = atual[chave] ?? v;
  }
  return resolvido;
}

/** Integracoes do usuario, com a chave mascarada (nunca volta em texto puro). */
export function integracoesDoUsuario(userId) {
  return many('SELECT * FROM crm_integracoes WHERE user_id=? ORDER BY created_at', userId).map((row) => {
    const cfg = lerConfig(row);
    const provider = PROVEDORES[row.provider];
    const mascarada = {};
    for (const campo of provider?.campos ?? []) mascarada[campo.chave] = mascarar(cfg[campo.chave]);
    return {
      provider: row.provider,
      rotulo: provider?.rotulo ?? row.provider,
      ativo: Boolean(row.ativo),
      autoSync: Boolean(row.auto_sync),
      autoReuniao: Boolean(row.auto_reuniao),
      config: mascarada,
      ultimoErro: row.ultimo_erro,
      ultimaSincronizacao: row.ultima_sincronizacao,
    };
  });
}

export async function salvarIntegracao({ userId, provider, config, autoSync, autoReuniao }) {
  const adaptador = PROVEDORES[provider];
  if (!adaptador) throw new Error('CRM desconhecido.');

  const resultado = await adaptador.testar(config); // valida antes de guardar
  const existente = one('SELECT id FROM crm_integracoes WHERE user_id=? AND provider=?', userId, provider);
  const payload = {
    config_enc: encriptar(JSON.stringify(config)),
    ativo: 1,
    auto_sync: autoSync ? 1 : 0,
    auto_reuniao: autoReuniao ? 1 : 0,
    ultimo_erro: null,
  };
  if (existente) update('crm_integracoes', existente.id, payload);
  else {
    insert('crm_integracoes', {
      id: uid('crm_'),
      user_id: userId,
      provider,
      created_at: nowIso(),
      ultima_sincronizacao: null,
      ...payload,
    });
  }
  log('crm', `${provider} conectado (${resultado.conta ?? 'ok'})`);
  return resultado;
}

export function removerIntegracao(userId, provider) {
  db.prepare('DELETE FROM crm_integracoes WHERE user_id=? AND provider=?').run(userId, provider);
}

export function statusDeSincronizacao(companyId) {
  return many('SELECT provider, status, external_url, synced_at, erro FROM crm_sincronizacoes WHERE company_id=?', companyId);
}

/** Envia (ou reenvia) um lead para um CRM especifico deste usuario. */
export async function enviarParaCrm({ userId, companyId, company, provider }) {
  const row = one('SELECT * FROM crm_integracoes WHERE user_id=? AND provider=? AND ativo=1', userId, provider);
  if (!row) throw new Error(`Integração com ${provider} não está ativa.`);
  const adaptador = PROVEDORES[provider];
  const config = lerConfig(row);

  const anterior = one('SELECT external_id FROM crm_sincronizacoes WHERE company_id=? AND provider=?', companyId, provider);

  try {
    const r = await adaptador.enviarLead(config, company, anterior?.external_id ?? null);
    const registro = {
      id: uid('sinc_'),
      company_id: companyId,
      user_id: userId,
      provider,
      external_id: r.externalId ?? null,
      external_url: r.url ?? null,
      status: 'ok',
      erro: null,
      synced_at: nowIso(),
    };
    if (anterior) {
      db.prepare(
        'UPDATE crm_sincronizacoes SET external_id=?, external_url=?, status=?, erro=?, synced_at=? WHERE company_id=? AND provider=?'
      ).run(registro.external_id, registro.external_url, registro.status, registro.erro, registro.synced_at, companyId, provider);
    } else {
      insert('crm_sincronizacoes', registro);
    }
    update('crm_integracoes', row.id, { ultima_sincronizacao: nowIso(), ultimo_erro: null });
    emit('crm:sincronizado', { companyId, provider, url: r.url });
    return registro;
  } catch (err) {
    update('crm_integracoes', row.id, { ultimo_erro: err.message });
    const registro = {
      id: uid('sinc_'),
      company_id: companyId,
      user_id: userId,
      provider,
      external_id: anterior?.external_id ?? null,
      external_url: null,
      status: 'erro',
      erro: err.message,
      synced_at: nowIso(),
    };
    if (anterior) {
      db.prepare('UPDATE crm_sincronizacoes SET status=?, erro=?, synced_at=? WHERE company_id=? AND provider=?').run(
        'erro',
        err.message,
        registro.synced_at,
        companyId,
        provider
      );
    } else {
      insert('crm_sincronizacoes', registro);
    }
    log('crm', `falha ao enviar para ${provider}: ${err.message}`);
    throw err;
  }
}

/** Envia para todos os CRMs ativos do usuario. Usado no botao manual. */
export async function enviarParaTodos({ userId, companyId, company }) {
  const ativos = many('SELECT provider FROM crm_integracoes WHERE user_id=? AND ativo=1', userId);
  const resultados = [];
  for (const { provider } of ativos) {
    try {
      await enviarParaCrm({ userId, companyId, company, provider });
      resultados.push({ provider, ok: true });
    } catch (err) {
      resultados.push({ provider, ok: false, erro: err.message });
    }
  }
  return resultados;
}

/**
 * Sincronizacao automatica: chamada nos dois momentos que importam (lead
 * salvo, empresa atendeu). So dispara para quem tem auto_sync ligado, e nunca
 * lanca excecao para quem chamou - falha de CRM nao pode derrubar a ligacao
 * ou a prospeccao.
 */
export function sincronizarSeAutomatico(userId, companyId, company) {
  if (!userId) return;
  const ativos = many('SELECT provider FROM crm_integracoes WHERE user_id=? AND ativo=1 AND auto_sync=1', userId);
  for (const { provider } of ativos) {
    enviarParaCrm({ userId, companyId, company, provider }).catch((err) =>
      log('crm', `auto-sync ${provider} falhou para ${company?.name}: ${err.message}`)
    );
  }
}

// ---------------------------------------------------------------------------
// Reuniao no CRM (agenda do Pipedrive, objeto Meeting do HubSpot, webhook)
// ---------------------------------------------------------------------------

/** Cria a reuniao num CRM especifico. Garante o contato/pessoa antes. */
export async function agendarReuniaoNoCrm({ userId, companyId, company, reuniao, provider }) {
  const row = one('SELECT * FROM crm_integracoes WHERE user_id=? AND provider=? AND ativo=1', userId, provider);
  if (!row) throw new Error(`Integração com ${provider} não está ativa.`);
  const adaptador = PROVEDORES[provider];
  if (!adaptador.agendarReuniao) throw new Error(`${provider} não suporta agendamento.`);
  const config = lerConfig(row);

  // O HubSpot/Pipedrive precisam do id do contato para vincular a reuniao.
  // Se o lead ainda nao foi pro CRM, manda agora.
  let externalId = one(
    'SELECT external_id FROM crm_sincronizacoes WHERE company_id=? AND provider=?',
    companyId,
    provider
  )?.external_id;
  if (!externalId && adaptador.enviarLead) {
    const r = await enviarParaCrm({ userId, companyId, company, provider }).catch(() => null);
    externalId = r?.external_id ?? null;
  }

  const r = await adaptador.agendarReuniao(config, company, reuniao, externalId);
  update('crm_integracoes', row.id, { ultima_sincronizacao: nowIso(), ultimo_erro: null });
  log('crm', `reunião de ${company?.name} criada no ${provider}.`);
  return { ok: true, externalId: r.externalId ?? null, url: r.url ?? null };
}

/** Cria a reuniao em todos os CRMs do usuario com auto_reuniao ligado. */
export async function agendarReuniaoEmTodos({ userId, companyId, company, reuniao }) {
  if (!userId) return [];
  const ativos = many(
    'SELECT provider FROM crm_integracoes WHERE user_id=? AND ativo=1 AND auto_reuniao=1',
    userId
  );
  const { registrarResultadoCrm } = await import('../reunioes.js');
  const resultados = [];
  for (const { provider } of ativos) {
    try {
      const r = await agendarReuniaoNoCrm({ userId, companyId, company, reuniao, provider });
      registrarResultadoCrm(reuniao.id, provider, r);
      resultados.push({ provider, ok: true });
    } catch (err) {
      registrarResultadoCrm(reuniao.id, provider, { ok: false });
      log('crm', `auto-reunião ${provider} falhou para ${company?.name}: ${err.message}`);
      resultados.push({ provider, ok: false, erro: err.message });
    }
  }
  return resultados;
}
