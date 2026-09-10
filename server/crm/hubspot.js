/**
 * HubSpot — CRM API v3, autenticacao por token de "private app".
 * Docs verificadas: developers.hubspot.com/docs/api/crm/contacts
 */
import { fetchWithTimeout } from '../util.js';

const BASE = 'https://api.hubspot.com';

const cabecalho = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

export const hubspot = {
  nome: 'hubspot',
  rotulo: 'HubSpot',
  campos: [
    { chave: 'apiToken', rotulo: 'Token do Private App', tipo: 'text', ajuda: 'Configurações > Integrações > Private Apps' },
  ],

  async testar({ apiToken }) {
    if (!apiToken) throw new Error('Informe o token do Private App.');
    const res = await fetchWithTimeout(
      `${BASE}/crm/v3/objects/contacts?limit=1`,
      { headers: cabecalho(apiToken) },
      12000
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.message ?? `HubSpot recusou o token (HTTP ${res.status}).`);
    }
    return { conta: 'conectado' };
  },

  /**
   * Cria/atualiza o contato. Com e-mail, usa upsert por e-mail (evita
   * duplicar mesmo sem guardarmos o id externo). Sem e-mail, cria uma vez e
   * guarda o id para as proximas sincronizacoes virarem PATCH.
   */
  async enviarLead({ apiToken }, company, externalId) {
    const [primeiroNome, ...resto] = String(company.name ?? '').split(' ');
    const properties = {
      firstname: primeiroNome || company.name,
      lastname: resto.join(' ') || undefined,
      company: company.name,
      ...(company.phone_e164 ? { phone: company.phone_e164 } : {}),
      ...(company.email ? { email: company.email } : {}),
      ...(company.website ? { website: company.website } : {}),
    };

    let resultado;
    if (externalId) {
      const res = await fetchWithTimeout(
        `${BASE}/crm/v3/objects/contacts/${externalId}`,
        { method: 'PATCH', headers: cabecalho(apiToken), body: JSON.stringify({ properties }) },
        12000
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message ?? `HubSpot: HTTP ${res.status}`);
      resultado = { externalId: data.id, url: `https://app.hubspot.com/contacts/${data.id}` };
    } else if (company.email) {
      const res = await fetchWithTimeout(
        `${BASE}/crm/v3/objects/contacts/batch/upsert`,
        {
          method: 'POST',
          headers: cabecalho(apiToken),
          body: JSON.stringify({ inputs: [{ id: company.email, idProperty: 'email', properties }] }),
        },
        12000
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message ?? `HubSpot: HTTP ${res.status}`);
      const item = data.results?.[0];
      resultado = { externalId: item?.id, url: item ? `https://app.hubspot.com/contacts/${item.id}` : null };
    } else {
      // Sem e-mail: cria direto. Se ja existir contato conflitante (409), o
      // erro sobe legivel em vez de travar a sincronizacao das outras.
      const res = await fetchWithTimeout(
        `${BASE}/crm/v3/objects/contacts`,
        { method: 'POST', headers: cabecalho(apiToken), body: JSON.stringify({ properties }) },
        12000
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message ?? `HubSpot: HTTP ${res.status}`);
      resultado = { externalId: data.id, url: `https://app.hubspot.com/contacts/${data.id}` };
    }

    // Resumo da ligacao (quando houver) vira uma nota anexada ao contato -
    // nao trava a sincronizacao principal se falhar, so registra e segue.
    if (company.resumo_ligacao && resultado.externalId) {
      await anexarNota(apiToken, resultado.externalId, company).catch(() => {});
    }

    return resultado;
  },
};

hubspot.agendarReuniao = async function ({ apiToken }, company, reuniao, contactId) {
  const inicio = new Date(reuniao.quando).getTime();
  const fim = inicio + (Number(reuniao.duracao_min) || 30) * 60000;
  const corpo = {
    properties: {
      hs_timestamp: inicio,
      hs_meeting_title: reuniao.titulo || `Reunião com ${company.name}`,
      hs_meeting_body: reuniao.notas || `Reunião agendada pelo IA SDR com ${company.name}.`,
      hs_meeting_start_time: inicio,
      hs_meeting_end_time: fim,
    },
    // 200 = associação padrão da HubSpot "reunião -> contato".
    ...(contactId
      ? {
          associations: [
            { to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 200 }] },
          ],
        }
      : {}),
  };
  const res = await fetchWithTimeout(
    `${BASE}/crm/v3/objects/meetings`,
    { method: 'POST', headers: cabecalho(apiToken), body: JSON.stringify(corpo) },
    12000
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message ?? `HubSpot (reunião): HTTP ${res.status}`);
  return { externalId: data.id, url: contactId ? `https://app.hubspot.com/contacts/${contactId}` : null };
};

async function anexarNota(apiToken, contactId, company) {
  const corpo =
    `<b>Resumo da ligação (IA SDR)</b><br>${(company.resumo_ligacao ?? '').replace(/\n/g, '<br>')}` +
    (company.gravacao_url ? `<br><br><i>Gravação disponível no painel do IA SDR.</i>` : '');
  const res = await fetchWithTimeout(
    `${BASE}/crm/v3/objects/notes`,
    {
      method: 'POST',
      headers: cabecalho(apiToken),
      body: JSON.stringify({
        properties: { hs_note_body: corpo, hs_timestamp: Date.now() },
        // 202 = associação padrão da HubSpot "nota -> contato".
        associations: [
          { to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] },
        ],
      }),
    },
    12000
  );
  if (!res.ok) throw new Error(`HubSpot (nota): HTTP ${res.status}`);
}
