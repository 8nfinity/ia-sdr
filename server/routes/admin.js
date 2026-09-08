/**
 * Área do administrador: quem são os usuários, quanto cada um gasta e o que
 * está acontecendo no sistema. Protegida pelo middleware de papel em auth.js.
 */
import express from 'express';
import { metricasAdmin, update, one, many } from '../db.js';
import { listarUsuarios, buscarPorId, criarUsuario, trocarSenha, publico } from '../usuarios.js';
import { log } from '../realtime.js';

export const adminRouter = express.Router();

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => res.status(400).json({ error: err.message }));

/** Painel: métricas gerais + retrato de cada usuário. */
adminRouter.get('/painel', (_req, res) => res.json(metricasAdmin()));

adminRouter.get('/usuarios', (_req, res) => res.json(listarUsuarios()));

adminRouter.post(
  '/usuarios',
  wrap(async (req, res) => {
    const { nome, email, senha, papel } = req.body ?? {};
    const u = criarUsuario({ nome, email, senha, papel: papel === 'admin' ? 'admin' : 'usuario' });
    log('admin', `usuario criado: ${u.email} (${u.papel})`);
    res.json(publico(u));
  })
);

adminRouter.patch(
  '/usuarios/:id',
  wrap(async (req, res) => {
    const alvo = buscarPorId(req.params.id);
    if (!alvo) throw new Error('Usuario nao encontrado.');

    const patch = {};
    const { status, papel, limiteUsd, nome, senha } = req.body ?? {};

    if (status === 'ativo' || status === 'bloqueado') {
      // Trancar a si mesmo para fora seria um jeito rapido de perder o sistema.
      if (alvo.id === req.usuario.id && status === 'bloqueado') {
        throw new Error('Voce nao pode bloquear a propria conta.');
      }
      patch.status = status;
    }
    if (papel === 'admin' || papel === 'usuario') {
      if (alvo.id === req.usuario.id && papel !== 'admin') {
        throw new Error('Voce nao pode remover o proprio acesso de administrador.');
      }
      patch.papel = papel;
    }
    if (limiteUsd !== undefined) {
      patch.limite_usd = limiteUsd === null || limiteUsd === '' ? null : Number(limiteUsd);
    }
    if (nome) patch.nome = String(nome).trim();

    if (Object.keys(patch).length) update('usuarios', alvo.id, patch);
    if (senha) trocarSenha(alvo.id, senha);

    log('admin', `usuario ${alvo.email} atualizado: ${JSON.stringify(patch)}`);
    res.json(publico(buscarPorId(alvo.id)));
  })
);

/** Detalhe de um usuário: o que ele fez e quanto gastou. */
adminRouter.get('/usuarios/:id', (req, res) => {
  const u = buscarPorId(req.params.id);
  if (!u) return res.status(404).json({ error: 'usuario nao encontrado' });
  res.json({
    usuario: publico(u),
    buscas: many(
      'SELECT id, segment, region, quantity, status, custo_usd, created_at FROM searches WHERE user_id=? ORDER BY created_at DESC LIMIT 30',
      u.id
    ),
    campanhas: many(
      `SELECT c.id, c.name, c.status, c.created_at,
        (SELECT COUNT(*) FROM calls WHERE campaign_id=c.id) ligacoes,
        (SELECT COUNT(*) FROM calls WHERE campaign_id=c.id AND is_winner=1) atendidas
       FROM campaigns c WHERE c.user_id=? ORDER BY c.created_at DESC LIMIT 20`,
      u.id
    ),
    gastoPorDia: many(
      `SELECT substr(created_at,1,10) dia, COALESCE(SUM(usd),0) usd
       FROM uso WHERE user_id=? GROUP BY dia ORDER BY dia DESC LIMIT 14`,
      u.id
    ).reverse(),
    totais: one(
      `SELECT COALESCE(SUM(usd),0) gasto, COUNT(*) chamadas,
        (SELECT COUNT(*) FROM companies WHERE user_id=?) leads
       FROM uso WHERE user_id=?`,
      u.id,
      u.id
    ),
  });
});
