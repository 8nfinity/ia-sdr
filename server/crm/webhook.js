/**
 * Webhook generico: manda o lead como JSON para qualquer URL.
 *
 * E o jeito de conectar CRM que nao tem adaptador proprio aqui - RD Station,
 * Kommo, Agendor, Salesforce, uma planilha do Google via Zapier/Make/n8n,
 * ou um endpoint proprio do cliente. Zero API de terceiro para acertar:
 * quem decide o formato de chegada e a ferramenta do outro lado.
 */
import { fetchWithTimeout } from '../util.js';

export const webhook = {
  nome: 'webhook',
  rotulo: 'Webhook (Zapier, Make, n8n, outro CRM)',
  campos: [{ chave: 'url', rotulo: 'URL do webhook', tipo: 'text', ajuda: 'https://hooks.zapier.com/... ou o endpoint do seu CRM' }],

  async testar({ url }) {
    if (!/^https:\/\//.test(String(url ?? ''))) throw new Error('Informe uma URL https:// valida.');
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evento: 'teste', origem: 'IA SDR', quando: new Date().toISOString() }),
      },
      12000
    );
    if (!res.ok) throw new Error(`O endereco respondeu HTTP ${res.status}.`);
    return { conta: 'endereco respondeu OK' };
  },

  async enviarLead({ url }, company) {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evento: 'lead',
          origem: 'IA SDR',
          quando: new Date().toISOString(),
          lead: {
            nome: company.name,
            telefone: company.phone_e164,
            email: company.email,
            instagram: company.instagram,
            site: company.website,
            endereco: company.address,
            score: company.score,
            status: company.status,
            resumoLigacao: company.resumo_ligacao || null,
            transcricaoLigacao: company.transcricao_texto || null,
          },
        }),
      },
      12000
    );
    if (!res.ok) throw new Error(`O endereco respondeu HTTP ${res.status}.`);
    // Webhook nao devolve um id de registro: nao ha o que guardar para virar
    // "update" depois, entao cada sincronizacao e um novo POST (esperado).
    return { externalId: null, url: null };
  },

  async agendarReuniao({ url }, company, reuniao) {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          evento: 'reuniao_agendada',
          origem: 'IA SDR',
          quando: new Date().toISOString(),
          lead: { nome: company.name, telefone: company.phone_e164, email: company.email },
          reuniao: {
            quando: reuniao.quando,
            duracaoMin: reuniao.duracao_min,
            titulo: reuniao.titulo,
            notas: reuniao.notas,
          },
        }),
      },
      12000
    );
    if (!res.ok) throw new Error(`O endereco respondeu HTTP ${res.status}.`);
    return { externalId: null, url: null };
  },
};
