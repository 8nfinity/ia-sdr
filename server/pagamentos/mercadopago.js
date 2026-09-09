/**
 * Mercado Pago via REST direto (mesmo padrão dos adaptadores de CRM em
 * server/crm/*.js) em vez do SDK oficial - evita depender da versão exata do
 * pacote e mantém tudo com a mesma cara do resto do projeto.
 *
 * Docs verificadas: mercadopago.com.br/developers (Assinaturas/Preapproval,
 * Checkout Transparente/Payments, Webhooks).
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { fetchWithTimeout } from '../util.js';

const BASE = 'https://api.mercadopago.com';

const cabecalho = () => ({
  Authorization: `Bearer ${config.mercadopago.accessToken}`,
  'Content-Type': 'application/json',
});

function exigirConfigurado() {
  if (!config.mercadopago.accessToken) {
    throw new Error('Mercado Pago não está configurado (MERCADOPAGO_ACCESS_TOKEN ausente no .env).');
  }
}

async function chamar(path, options = {}) {
  exigirConfigurado();
  const res = await fetchWithTimeout(`${BASE}${path}`, { headers: cabecalho(), ...options }, 15000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.message ?? data?.cause?.[0]?.description ?? `Mercado Pago: HTTP ${res.status}`);
  }
  return data;
}

/**
 * Cria a assinatura recorrente (sem plano associado no MP - o "plano" é o
 * nosso, em config.js). O card_token_id vem do MP.js tokenizando o cartão no
 * navegador do cliente: o número do cartão nunca passa pelo nosso servidor.
 */
export async function criarAssinatura({ email, cardTokenId, precoCentavos, motivo, externalReference }) {
  return chamar('/preapproval', {
    method: 'POST',
    body: JSON.stringify({
      reason: motivo,
      external_reference: externalReference,
      payer_email: email,
      card_token_id: cardTokenId,
      back_url: config.publicBaseUrl || 'https://mercadopago.com.br',
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: precoCentavos / 100,
        currency_id: 'BRL',
      },
      status: 'authorized',
    }),
  });
}

export async function buscarAssinatura(id) {
  return chamar(`/preapproval/${id}`);
}

export async function cancelarAssinatura(id) {
  return chamar(`/preapproval/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) });
}

/** Compra avulsa (pacote de créditos) - cobrança única, sem recorrência. */
export async function criarPagamentoAvulso({ email, cardTokenId, valorCentavos, descricao, externalReference }) {
  return chamar('/v1/payments', {
    method: 'POST',
    // Idempotência: se o navegador reenviar o clique, o MP não cobra 2x.
    headers: { ...cabecalho(), 'X-Idempotency-Key': externalReference },
    body: JSON.stringify({
      transaction_amount: valorCentavos / 100,
      token: cardTokenId,
      description: descricao,
      installments: 1,
      payment_method_id: undefined, // o MP infere pelo token do cartão
      external_reference: externalReference,
      payer: { email },
    }),
  });
}

export async function buscarPagamento(id) {
  return chamar(`/v1/payments/${id}`);
}

/**
 * Valida a assinatura do webhook (header x-signature) contra o secret
 * configurado no Console. Sem isso, qualquer um poderia forjar um POST
 * dizendo "esse pagamento foi aprovado" e ganhar créditos de graça.
 */
export function validarWebhook({ xSignature, xRequestId, dataId }) {
  if (!config.mercadopago.webhookSecret) return true; // sem secret configurado: pula (dev/sandbox)
  if (!xSignature || !dataId) return false;

  const partes = Object.fromEntries(
    xSignature.split(',').map((p) => p.trim().split('=').map((s) => s.trim()))
  );
  const ts = partes.ts;
  const hash = partes.v1;
  if (!ts || !hash) return false;

  const template = `id:${dataId};request-id:${xRequestId ?? ''};ts:${ts};`;
  const calculado = crypto.createHmac('sha256', config.mercadopago.webhookSecret).update(template).digest('hex');
  const a = Buffer.from(calculado);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
