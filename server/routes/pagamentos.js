/**
 * Checkout: assinatura de plano (recorrente) e compra de créditos extra
 * (avulso), via Mercado Pago Checkout Transparente. O cartão nunca passa por
 * aqui - o navegador do cliente gera um card_token_id com o MP.js, e é só
 * isso que chega no corpo destas rotas.
 */
import express from 'express';
import { config } from '../config.js';
import { update, insert } from '../db.js';
import { uid, nowIso } from '../util.js';
import { log } from '../realtime.js';
import { PLANOS, CREDITOS, fichaDoUsuario } from '../pagamentos/planos.js';
import { criarAssinatura, criarPagamentoAvulso, cancelarAssinatura } from '../pagamentos/mercadopago.js';

export const pagamentosRouter = express.Router();

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    log('pagamentos', `erro: ${err.message}`);
    res.status(400).json({ error: err.message, ...(err.dados || {}) });
  });

pagamentosRouter.get('/planos', (_req, res) => {
  res.json({
    planos: Object.values(PLANOS),
    creditos: Object.values(CREDITOS),
    publicKey: config.mercadopago.publicKey,
    configurado: Boolean(config.mercadopago.accessToken && config.mercadopago.publicKey),
  });
});

pagamentosRouter.get('/status', (req, res) => {
  res.json(fichaDoUsuario(req.usuario.id));
});

/** Assina (ou troca de) plano - cobra a mensalidade na hora. */
pagamentosRouter.post(
  '/assinar',
  wrap(async (req, res) => {
    const { plano: planoId, cardTokenId, email } = req.body ?? {};
    const plano = PLANOS[planoId];
    if (!plano) throw new Error('Plano inválido.');
    if (!cardTokenId) throw new Error('Cartão não informado.');

    const externalReference = `sub:${req.usuario.id}:${uid('')}`;
    const assinatura = await criarAssinatura({
      email: email || req.usuario.email,
      cardTokenId,
      precoCentavos: plano.precoCentavos,
      motivo: `IA SDR - Plano ${plano.nome}`,
      externalReference,
    });

    insert('pagamentos_mp', {
      id: uid('pag_'),
      user_id: req.usuario.id,
      tipo: 'assinatura',
      valor_centavos: plano.precoCentavos,
      status: assinatura.status,
      mp_id: String(assinatura.id),
      external_reference: externalReference,
      detalhe: plano.id,
      created_at: nowIso(),
    });

    if (assinatura.status === 'authorized') {
      const agora = nowIso();
      update('usuarios', req.usuario.id, {
        plano: plano.id,
        assinatura_status: 'ativa',
        assinatura_id_mp: String(assinatura.id),
        periodo_inicio: agora,
        periodo_fim: new Date(Date.now() + 30 * 86400000).toISOString(),
      });
      log('pagamentos', `${req.usuario.email}: assinou o plano ${plano.nome}.`);
      return res.json({ ok: true, status: 'ativa' });
    }

    // Ainda não autorizado (ex: análise antifraude) - o webhook confirma depois.
    res.json({ ok: true, status: assinatura.status, aviso: 'Pagamento em análise. Avisamos quando confirmar.' });
  })
);

pagamentosRouter.post(
  '/cancelar',
  wrap(async (req, res) => {
    const u = req.usuario;
    if (u.assinatura_id_mp) await cancelarAssinatura(u.assinatura_id_mp).catch(() => {});
    update('usuarios', u.id, { assinatura_status: 'cancelada' });
    log('pagamentos', `${u.email}: cancelou a assinatura.`);
    res.json({ ok: true });
  })
);

/** Compra avulsa de créditos extra - cobrança única, sem recorrência. */
pagamentosRouter.post(
  '/creditos',
  wrap(async (req, res) => {
    const { tipo, cardTokenId, email } = req.body ?? {};
    const pacote = CREDITOS[tipo];
    if (!pacote) throw new Error('Pacote de crédito inválido.');
    if (!cardTokenId) throw new Error('Cartão não informado.');

    const externalReference = `credito:${req.usuario.id}:${tipo}:${uid('')}`;
    const pagamento = await criarPagamentoAvulso({
      email: email || req.usuario.email,
      cardTokenId,
      valorCentavos: pacote.precoCentavos,
      descricao: `IA SDR - ${pacote.rotulo}`,
      externalReference,
    });

    insert('pagamentos_mp', {
      id: uid('pag_'),
      user_id: req.usuario.id,
      tipo: `credito_${tipo}`,
      valor_centavos: pacote.precoCentavos,
      status: pagamento.status,
      mp_id: String(pagamento.id),
      external_reference: externalReference,
      detalhe: String(pacote.quantidade),
      created_at: nowIso(),
    });

    if (pagamento.status === 'approved') {
      const campo = tipo === 'buscas' ? 'creditos_buscas' : 'creditos_ligacoes';
      const atual = req.usuario[campo] ?? 0;
      update('usuarios', req.usuario.id, { [campo]: atual + pacote.quantidade });
      log('pagamentos', `${req.usuario.email}: comprou ${pacote.rotulo}.`);
      return res.json({ ok: true, status: 'approved' });
    }

    res.json({ ok: true, status: pagamento.status, aviso: 'Pagamento em análise. Avisamos quando confirmar.' });
  })
);
