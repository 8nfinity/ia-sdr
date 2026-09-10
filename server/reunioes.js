/**
 * Agendamento de reunião: grava a reunião do lead e, se o CRM do usuário
 * estiver com "criar reunião no CRM" ligado, cria a atividade/reunião lá
 * também (agenda do Pipedrive, objeto Meeting do HubSpot, ou o payload do
 * webhook). Falha de CRM nunca derruba o agendamento local.
 */
import { insert, update, one, many, getCompany } from './db.js';
import { uid, nowIso } from './util.js';
import { emit, log } from './realtime.js';
import { agendarReuniaoEmTodos } from './crm/index.js';

export function agendarReuniao({ userId, companyId, campaignId = null, quando, duracaoMin = 30, titulo, notas }) {
  const company = getCompany(companyId);
  if (!company) throw new Error('Lead não encontrado.');
  if (!quando || Number.isNaN(Date.parse(quando))) throw new Error('Informe a data e a hora da reunião.');

  const id = uid('reu_');
  insert('reunioes', {
    id,
    company_id: companyId,
    campaign_id: campaignId,
    quando: new Date(quando).toISOString(),
    duracao_min: Number(duracaoMin) || 30,
    titulo: titulo || `Reunião com ${company.name}`,
    notas: notas || null,
    status: 'agendada',
    crm_provider: null,
    crm_external_id: null,
    crm_url: null,
    crm_status: null,
    created_at: nowIso(),
  });

  // Marca a empresa como "reunião" no funil (sem apagar histórico de status).
  update('companies', companyId, { status: 'reuniao' });

  const reuniao = one('SELECT * FROM reunioes WHERE id=?', id);
  emit('reuniao:agendada', { reuniao, company });
  log('reuniao', `${company.name}: reunião marcada para ${new Date(quando).toLocaleString('pt-BR')}.`);

  // Empurra pro(s) CRM(s) com auto_reuniao ligado - fire and forget.
  agendarReuniaoEmTodos({ userId, companyId, company, reuniao }).catch((err) =>
    log('reuniao', `push da reunião pro CRM falhou: ${err.message}`)
  );

  return reuniao;
}

export function atualizarReuniao(id, patch) {
  const permitido = {};
  if (['agendada', 'realizada', 'no-show', 'cancelada'].includes(patch.status)) permitido.status = patch.status;
  if (patch.quando && !Number.isNaN(Date.parse(patch.quando))) permitido.quando = new Date(patch.quando).toISOString();
  if (patch.notas !== undefined) permitido.notas = patch.notas;
  if (!Object.keys(permitido).length) return one('SELECT * FROM reunioes WHERE id=?', id);
  update('reunioes', id, permitido);
  return one('SELECT * FROM reunioes WHERE id=?', id);
}

export const listarReunioes = (userId) =>
  many(
    `SELECT r.*, (SELECT name FROM companies WHERE id=r.company_id) empresa,
       (SELECT phone_e164 FROM companies WHERE id=r.company_id) telefone
     FROM reunioes r WHERE r.user_id=? ORDER BY r.quando DESC LIMIT 200`,
    userId
  );

/** Registra o resultado da tentativa de criar a reunião num CRM. */
export function registrarResultadoCrm(reuniaoId, provider, resultado) {
  update('reunioes', reuniaoId, {
    crm_provider: provider,
    crm_external_id: resultado.externalId ?? null,
    crm_url: resultado.url ?? null,
    crm_status: resultado.ok ? 'ok' : 'erro',
  });
}
