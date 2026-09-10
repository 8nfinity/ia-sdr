/**
 * Área do administrador: quem são os usuários, quanto cada um gasta e o que
 * está acontecendo no sistema. Protegida pelo middleware de papel em auth.js.
 */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'libsql';
import { metricasAdmin, update, one, many, db, bancoEm, usandoTurso } from '../db.js';
import { listarUsuarios, buscarPorId, criarUsuario, trocarSenha, publico } from '../usuarios.js';
import { log } from '../realtime.js';
import { saldoTwilio, saldoAnthropicEstimado, registrarRecargaAnthropic } from '../saldo.js';
import { PLANOS } from '../pagamentos/planos.js';
import { statusBackup, enviarBackup } from '../persistencia.js';

export const adminRouter = express.Router();

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => res.status(400).json({ error: err.message }));

/** Painel: métricas gerais + retrato de cada usuário. */
adminRouter.get('/painel', (_req, res) => res.json(metricasAdmin()));

/**
 * Saldo estimado da operação nas contas por trás do sistema (Twilio +
 * Anthropic) - não confundir com o saldo/limite de um cliente. Serve para
 * você saber se precisa recarregar antes que as ligações/buscas comecem a
 * falhar pra todo mundo de uma vez.
 */
adminRouter.get(
  '/saldo',
  wrap(async (_req, res) => {
    const twilio = await saldoTwilio().catch((err) => ({ erro: err.message }));
    res.json({ twilio, anthropic: saldoAnthropicEstimado() });
  })
);

/** Estado da persistência: volume + backup remoto (último e frequência). */
adminRouter.get(
  '/persistencia',
  wrap(async (_req, res) => res.json(await statusBackup()))
);

/** Força um backup remoto agora (além dos automáticos). */
adminRouter.post(
  '/persistencia/backup',
  wrap(async (_req, res) => {
    if (usandoTurso) { try { db.sync(); } catch { /* ok */ } }
    try { db.exec('PRAGMA wal_checkpoint(FULL);'); } catch { /* replica */ }
    await enviarBackup(fs.readFileSync(bancoEm), 'manual');
    res.json(await statusBackup());
  })
);

/** Registra que você acabou de recarregar a Anthropic (não existe API pra isso lá). */
adminRouter.post(
  '/saldo/anthropic',
  wrap(async (req, res) => {
    const { valorUsd } = req.body ?? {};
    const n = Number(valorUsd);
    if (!n || n <= 0) throw new Error('Informe o valor recarregado (em dólares).');
    registrarRecargaAnthropic(n);
    log('admin', `recarga da Anthropic registrada: US$ ${n.toFixed(2)}`);
    res.json(saldoAnthropicEstimado());
  })
);

/**
 * Baixa uma cópia do banco inteiro (todos os usuários, leads, campanhas).
 * Serve pra guardar antes de qualquer mudança arriscada na hospedagem, como
 * criar um volume persistente pela primeira vez.
 */
adminRouter.get('/backup', (_req, res) => {
  if (usandoTurso) { try { db.sync(); } catch { /* usa o que tiver na replica */ } }
  // Em modo WAL parte dos dados recentes fica num arquivo -wal à parte;
  // o checkpoint junta tudo de volta no arquivo principal antes de copiar.
  db.exec('PRAGMA wal_checkpoint(FULL);');
  const nome = `iasdr-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.db`;
  // dotfiles:'allow' porque o DATA_DIR de algumas hospedagens usa pasta
  // oculta (ex: comeca com "."), e o Express bloqueia isso por padrao.
  res.download(bancoEm, nome, { dotfiles: 'allow' }, (err) => {
    if (err) log('admin', `falha ao baixar backup: ${err.message}`);
  });
});

/**
 * Restaura o banco a partir de um arquivo de backup (.db) enviado em base64.
 * Copia registro por registro do arquivo para o banco vivo, numa transação -
 * assim funciona igual com SQLite local E com Turso (as escritas vao pro
 * Turso na hora, sem precisar reiniciar nem trocar arquivo).
 */
adminRouter.post(
  '/restaurar',
  wrap(async (req, res) => {
    const { arquivo } = req.body ?? {};
    if (!arquivo) throw new Error('Envie o arquivo de backup (.db).');
    const base64 = arquivo.includes(',') ? arquivo.split(',')[1] : arquivo;
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.subarray(0, 15).toString('latin1') !== 'SQLite format 3') {
      throw new Error('Esse arquivo não parece um backup válido do IA SDR (esperado um .db do SQLite).');
    }

    const tmp = path.join(os.tmpdir(), `iasdr-restaurar-${Date.now()}.db`);
    fs.writeFileSync(tmp, buffer);
    let copiados = 0;
    try {
      const origem = new Database(tmp, { readonly: true });
      const tabelas = origem
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name);

      const aplicar = db.transaction(() => {
        for (const t of tabelas) {
          const linhas = origem.prepare(`SELECT * FROM ${t}`).all();
          db.exec(`DELETE FROM ${t}`);
          if (!linhas.length) continue;
          const colunas = Object.keys(linhas[0]).filter((c) => c !== '_metadata');
          const ins = db.prepare(
            `INSERT INTO ${t} (${colunas.join(',')}) VALUES (${colunas.map(() => '?').join(',')})`
          );
          for (const l of linhas) { ins.run(...colunas.map((c) => l[c] ?? null)); copiados++; }
        }
      });
      aplicar();
      origem.close();
    } finally {
      try { fs.rmSync(tmp); } catch { /* ok */ }
    }

    log('admin', `banco restaurado de um backup: ${copiados} registros.`);
    res.json({ ok: true, aviso: `Restaurado (${copiados} registros). Recarregue a página.` });
  })
);

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
    const { status, papel, limiteUsd, nome, senha, plano, assinaturaStatus, creditosBuscas, creditosLigacoes } =
      req.body ?? {};

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

    // Ajustes manuais de plano/assinatura - suporte (cortesia, correção de
    // cobrança, teste). "plano: null" tira o cliente de qualquer plano.
    if (plano !== undefined) {
      if (plano !== null && !PLANOS[plano]) throw new Error('Plano inválido.');
      patch.plano = plano;
    }
    if (assinaturaStatus !== undefined) {
      if (!['ativa', 'atrasada', 'cancelada', 'nenhuma'].includes(assinaturaStatus)) {
        throw new Error('Status de assinatura inválido.');
      }
      patch.assinatura_status = assinaturaStatus;
      // Ativar manualmente sem período definido: abre um ciclo novo agora,
      // senão a cota fica contando desde a criação da conta (ciclo enorme).
      if (assinaturaStatus === 'ativa' && !alvo.periodo_inicio) {
        patch.periodo_inicio = new Date().toISOString();
        patch.periodo_fim = new Date(Date.now() + 30 * 86400000).toISOString();
      }
    }
    if (creditosBuscas !== undefined) patch.creditos_buscas = Math.max(0, Number(creditosBuscas) || 0);
    if (creditosLigacoes !== undefined) patch.creditos_ligacoes = Math.max(0, Number(creditosLigacoes) || 0);

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
