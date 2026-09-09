/**
 * Webhook do Mercado Pago: pagamentos (assinatura inicial, renovação mensal
 * automática, compra avulsa de créditos) e mudanças de status da assinatura.
 *
 * Regra de ouro: NUNCA confiar no corpo do POST para decidir o que aconteceu
 * - ele só diz "algo mudou no recurso X"; sempre buscamos o recurso de novo
 * na API do Mercado Pago antes de agir. Isso também evita que alguém forje
 * uma notificação falsa (além da validação de assinatura abaixo).
 */
import express from 'express';
import { one, update, insert } from '../db.js';
import { uid, nowIso } from '../util.js';
import { log } from '../realtime.js';
import { buscarPorId } from '../usuarios.js';
import { CREDITOS } from '../pagamentos/planos.js';
import { validarWebhook, buscarPagamento, buscarAssinatura } from '../pagamentos/mercadopago.js';

export const webhooksMpRouter = express.Router();

/** userId embutido no external_reference que a gente mesmo gerou ao cobrar. */
function usuarioDaReferencia(ref) {
  const partes = String(ref ?? '').split(':');
  if (partes[0] === 'sub' || partes[0] === 'credito') return partes[1];
  return null;
}

async function tratarPagamento(paymentId) {
  const pagamento = await buscarPagamento(paymentId);
  const ref = pagamento.external_reference ?? '';
  const userId = usuarioDaReferencia(ref);
  if (!userId) {
    log('pagamentos', `webhook: pagamento ${paymentId} sem referência reconhecida (external_reference="${ref}") - ignorado.`);
    return;
  }
  const usuario = buscarPorId(userId);
  if (!usuario) return;

  const existente = one('SELECT * FROM pagamentos_mp WHERE mp_id=?', String(paymentId));
  const jaAplicado = existente?.status === 'approved';

  if (existente) {
    update('pagamentos_mp', existente.id, { status: pagamento.status });
  } else {
    insert('pagamentos_mp', {
      id: uid('pag_'),
      user_id: userId,
      tipo: ref.startsWith('sub:') ? 'assinatura' : 'credito',
      valor_centavos: Math.round((pagamento.transaction_amount ?? 0) * 100),
      status: pagamento.status,
      mp_id: String(paymentId),
      external_reference: ref,
      detalhe: null,
      created_at: nowIso(),
    });
  }

  if (jaAplicado || pagamento.status !== 'approved') {
    // Falha/recusa numa cobrança de ASSINATURA (renovação que não passou):
    // bloqueia na hora, como decidido - o cliente vê e resolve o cartão.
    if (!jaAplicado && ref.startsWith('sub:') && ['rejected', 'cancelled'].includes(pagamento.status)) {
      update('usuarios', userId, { assinatura_status: 'atrasada' });
      log('pagamentos', `${usuario.email}: cobrança da assinatura falhou (${pagamento.status}) - acesso bloqueado.`);
    }
    return;
  }

  if (ref.startsWith('sub:')) {
    // Aprovado: cobrança inicial OU renovação mensal automática. Reabre o
    // ciclo (a cota de buscas/ligações do mês reinicia sozinha a partir daqui,
    // porque tudo é contado com "created_at >= periodo_inicio").
    const agora = nowIso();
    update('usuarios', userId, {
      assinatura_status: 'ativa',
      periodo_inicio: agora,
      periodo_fim: new Date(Date.now() + 30 * 86400000).toISOString(),
    });
    log('pagamentos', `${usuario.email}: cobrança da assinatura aprovada - ciclo renovado.`);
  } else if (ref.startsWith('credito:')) {
    const tipo = ref.split(':')[2]; // credito:<userId>:<tipo>:<rand>
    const campo = tipo === 'buscas' ? 'creditos_buscas' : tipo === 'ligacoes' ? 'creditos_ligacoes' : null;
    const quantidade = CREDITOS[tipo]?.quantidade ?? 0;
    if (!campo || !quantidade) return;
    const atual = usuario[campo] ?? 0;
    update('usuarios', userId, { [campo]: atual + quantidade });
    log('pagamentos', `${usuario.email}: crédito avulso aprovado (+${quantidade} ${tipo}).`);
  }
}

async function tratarAssinatura(preapprovalId) {
  const assinatura = await buscarAssinatura(preapprovalId);
  const userId = usuarioDaReferencia(assinatura.external_reference);
  if (!userId) return;
  const usuario = buscarPorId(userId);
  if (!usuario) return;

  const status = assinatura.status === 'authorized' ? 'ativa' : assinatura.status === 'paused' ? 'atrasada' : 'cancelada';
  update('usuarios', userId, { assinatura_status: status });
  log('pagamentos', `${usuario.email}: assinatura ${status} (Mercado Pago: ${assinatura.status}).`);
}

webhooksMpRouter.post('/', async (req, res) => {
  const dataId = req.query['data.id'] || req.body?.data?.id || req.body?.id;
  const tipo = req.query.type || req.body?.type;

  const valido = validarWebhook({
    xSignature: req.get('x-signature'),
    xRequestId: req.get('x-request-id'),
    dataId: String(dataId ?? ''),
  });
  if (!valido) {
    log('pagamentos', 'webhook do Mercado Pago com assinatura inválida - recusado.');
    return res.sendStatus(401);
  }

  // Responde rápido; processa depois. O Mercado Pago só quer o 200 em
  // poucos segundos, e reenvia se não conseguir.
  res.sendStatus(200);

  try {
    if (tipo === 'payment') await tratarPagamento(dataId);
    else if (tipo === 'preapproval' || tipo === 'subscription_preapproval') await tratarAssinatura(dataId);
  } catch (err) {
    log('pagamentos', `erro processando webhook (${tipo} ${dataId}): ${err.message}`);
  }
});
