/**
 * Pipedrive — API v2, autenticacao por token simples (sem OAuth).
 * Docs verificadas: developers.pipedrive.com/docs/api/v1
 */
import { fetchWithTimeout } from '../util.js';

const base = (dominio) => `https://${dominio || 'api'}.pipedrive.com`;

export const pipedrive = {
  nome: 'pipedrive',
  rotulo: 'Pipedrive',
  campos: [{ chave: 'apiToken', rotulo: 'API Token', tipo: 'text', ajuda: 'Configurações > Empresa > Chaves de API' }],

  async testar({ apiToken }) {
    if (!apiToken) throw new Error('Informe o API Token.');
    const res = await fetchWithTimeout(
      `${base()}/api/v1/users/me?api_token=${encodeURIComponent(apiToken)}`,
      {},
      12000
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      throw new Error(data?.error ?? `Pipedrive recusou o token (HTTP ${res.status}).`);
    }
    return { conta: data.data?.company_name ?? data.data?.name ?? 'conectado' };
  },

  /**
   * Cria (ou atualiza, se ja sincronizado antes) a pessoa no Pipedrive.
   * Devolve o id externo, que o chamador guarda para a proxima sincronizacao
   * virar update em vez de criar duplicado.
   */
  async enviarLead({ apiToken }, company, externalId) {
    const corpo = {
      name: company.name,
      ...(company.phone_e164 ? { phones: [{ value: company.phone_e164, primary: true, label: 'work' }] } : {}),
      ...(company.email ? { emails: [{ value: company.email, primary: true, label: 'work' }] } : {}),
    };

    const url = externalId
      ? `${base()}/api/v2/persons/${externalId}?api_token=${encodeURIComponent(apiToken)}`
      : `${base()}/api/v2/persons?api_token=${encodeURIComponent(apiToken)}`;

    const res = await fetchWithTimeout(
      url,
      {
        method: externalId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      },
      12000
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data?.error ?? `Pipedrive: HTTP ${res.status}`);
    const idPessoa = String(data.data.id);

    // Resumo da ligacao (quando houver) vira uma nota anexada a pessoa - nao
    // trava a sincronizacao principal se falhar, so registra e segue.
    if (company.resumo_ligacao) {
      await anexarNota({ apiToken }, idPessoa, company).catch(() => {});
    }

    return { externalId: idPessoa, url: `https://app.pipedrive.com/person/${idPessoa}` };
  },
};

async function anexarNota({ apiToken }, personId, company) {
  const conteudo =
    `<b>Resumo da ligação (IA SDR)</b><br>${escapeHtml(company.resumo_ligacao)}` +
    (company.gravacao_url ? `<br><br><i>Gravação disponível no painel do IA SDR.</i>` : '');
  const res = await fetchWithTimeout(
    `${base()}/api/v1/notes?api_token=${encodeURIComponent(apiToken)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: conteudo, person_id: Number(personId) }),
    },
    12000
  );
  if (!res.ok) throw new Error(`Pipedrive (nota): HTTP ${res.status}`);
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
