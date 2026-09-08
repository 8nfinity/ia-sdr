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

    if (externalId) {
      const res = await fetchWithTimeout(
        `${BASE}/crm/v3/objects/contacts/${externalId}`,
        { method: 'PATCH', headers: cabecalho(apiToken), body: JSON.stringify({ properties }) },
        12000
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message ?? `HubSpot: HTTP ${res.status}`);
      return { externalId: data.id, url: `https://app.hubspot.com/contacts/${data.id}` };
    }

    if (company.email) {
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
      return { externalId: item?.id, url: item ? `https://app.hubspot.com/contacts/${item.id}` : null };
    }

    // Sem e-mail: cria direto. Se ja existir contato conflitante (409), o
    // erro sobe legivel em vez de travar a sincronizacao das outras.
    const res = await fetchWithTimeout(
      `${BASE}/crm/v3/objects/contacts`,
      { method: 'POST', headers: cabecalho(apiToken), body: JSON.stringify({ properties }) },
      12000
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message ?? `HubSpot: HTTP ${res.status}`);
    return { externalId: data.id, url: `https://app.hubspot.com/contacts/${data.id}` };
  },
};
