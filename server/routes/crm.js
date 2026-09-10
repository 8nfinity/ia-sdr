import express from 'express';
import { getCompany } from '../db.js';
import { log } from '../realtime.js';
import {
  listarProvedores,
  integracoesDoUsuario,
  salvarIntegracao,
  removerIntegracao,
  enviarParaCrm,
  enviarParaTodos,
  statusDeSincronizacao,
  resolverConfig,
  PROVEDORES,
} from '../crm/index.js';

export const crmRouter = express.Router();

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    log('api', `erro crm: ${err.message}`);
    res.status(400).json({ error: err.message });
  });

crmRouter.get('/provedores', (_req, res) => res.json(listarProvedores()));

crmRouter.get('/', (req, res) => res.json(integracoesDoUsuario(req.usuario.id)));

crmRouter.post(
  '/:provider',
  wrap(async (req, res) => {
    const { autoSync, autoReuniao } = req.body ?? {};
    // Resolve campos deixados com a mascara/em branco usando o valor ja
    // salvo, para "so mudar o auto-sync" nao apagar a chave gravada.
    const config = resolverConfig(req.usuario.id, req.params.provider, req.body?.config ?? {});
    const resultado = await salvarIntegracao({
      userId: req.usuario.id,
      provider: req.params.provider,
      config,
      autoSync: Boolean(autoSync),
      autoReuniao: Boolean(autoReuniao),
    });
    res.json({ ok: true, ...resultado });
  })
);

crmRouter.post(
  '/:provider/testar',
  wrap(async (req, res) => {
    const adaptador = PROVEDORES[req.params.provider];
    if (!adaptador) throw new Error('CRM desconhecido.');
    const config = resolverConfig(req.usuario.id, req.params.provider, req.body?.config ?? {});
    const resultado = await adaptador.testar(config);
    res.json({ ok: true, ...resultado });
  })
);

crmRouter.delete('/:provider', (req, res) => {
  removerIntegracao(req.usuario.id, req.params.provider);
  res.json({ ok: true });
});

/**
 * Envia um lead para um CRM especifico ou para todos os ativos.
 * Duas rotas em vez de um parametro opcional (":provider?") porque o Express
 * 5 usa uma versao mais estrita do path-to-regexp, que nao aceita mais esse
 * atalho de sintaxe do Express 4.
 */
crmRouter.post(
  '/enviar/:companyId',
  wrap(async (req, res) => {
    const company = getCompany(req.params.companyId);
    if (!company) throw new Error('Lead não encontrado.');
    const r = await enviarParaTodos({ userId: req.usuario.id, companyId: company.id, company });
    res.json({ resultados: r });
  })
);

crmRouter.post(
  '/enviar/:companyId/:provider',
  wrap(async (req, res) => {
    const company = getCompany(req.params.companyId);
    if (!company) throw new Error('Lead não encontrado.');
    const r = await enviarParaCrm({
      userId: req.usuario.id,
      companyId: company.id,
      company,
      provider: req.params.provider,
    });
    res.json(r);
  })
);

crmRouter.get('/status/:companyId', (req, res) => {
  res.json(statusDeSincronizacao(req.params.companyId));
});
