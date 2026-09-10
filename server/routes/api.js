import express from 'express';
import { config, integrationStatus, voiceMode, telefoneDoVendedor, definirVendedorSalvo } from '../config.js';
import { one, many, getCompany, listCompanies, update, resumoDeCustos, setSetting, insert, saveCompany, gastoDoUsuario, metricasCliente } from '../db.js';
import { agendarReuniao, atualizarReuniao, listarReunioes } from '../reunioes.js';
import { uid, toE164BR, isPlausiblePhone, tipoTelefone, nowIso } from '../util.js';
import { log, emit } from '../realtime.js';
import { filtroDoDono, usuarioAtual, ehAdmin } from '../contexto.js';
import { lerPlanilha } from '../prospect/planilha.js';
import { runSearch } from '../prospect/index.js';
import { startCampaign, engine } from '../voice/campaign.js';
import { sendWhatsapp, historyOf, statusDaFila } from '../whatsapp/index.js';
import { sincronizarSeAutomatico } from '../crm/index.js';
import { conferirCotaBusca, conferirCotaLigacoes } from '../pagamentos/planos.js';

export const apiRouter = express.Router();

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    log('api', `erro: ${err.message}`);
    // err.dados carrega o "codigo" (ex: limite_plano) que o front usa para
    // oferecer a compra de créditos em vez de só mostrar um erro genérico.
    res.status(400).json({ error: err.message, ...(err.dados || {}) });
  });

/**
 * Barra a operacao se o usuario ja passou do limite de gasto definido pelo
 * administrador. Vale para o que consome API paga: buscar e ligar.
 */
function conferirLimite(req) {
  const u = req.usuario;
  // Sem limite = coluna nula. Limite ZERO e um limite de verdade (bloqueia
  // tudo); tratar 0 como "sem limite" deixaria o admin achar que travou o
  // usuario quando na pratica liberou.
  if (!u || u.papel === 'admin' || u.limite_usd === null || u.limite_usd === undefined) return;
  const gasto = gastoDoUsuario(u.id);
  if (gasto >= Number(u.limite_usd)) {
    throw new Error(
      `Voce atingiu o limite de US$ ${Number(u.limite_usd).toFixed(2)} ` +
        `(ja usou US$ ${gasto.toFixed(2)}). Fale com o administrador para liberar mais.`
    );
  }
}

// ---------------------------------------------------------------- status
apiRouter.get('/eu', (req, res) => {
  const u = req.usuario;
  res.json({ id: u.id, nome: u.nome, email: u.email, papel: u.papel, limiteUsd: u.limite_usd });
});

apiRouter.get('/status', (_req, res) => {
  res.json({
    integracoes: integrationStatus(),
    modoVoz: voiceMode(),
    empresa: config.business,
    whatsappProvider: config.whatsapp.provider,
    publicBaseUrl: config.publicBaseUrl || null,
    telefoneVendedor: telefoneDoVendedor(),
    modoLigacao: config.voice.modo,
  });
});

apiRouter.get('/custos', (_req, res) => {
  const r = resumoDeCustos(ehAdmin() ? null : usuarioAtual()?.id);
  res.json({
    ...r,
    precos: {
      modelo: config.anthropic.model,
      modelos: {
        busca: config.anthropic.modelBusca,
        auditoria: config.anthropic.modelAuditoria,
        conversa: config.anthropic.modelConversa,
      },
      entradaPorMilhao: 5,
      saidaPorMilhao: 25,
      buscaWeb: 0.01,
      fonte: 'platform.claude.com/docs/en/about-claude/pricing',
    },
  });
});

/** Painel de resultados do cliente: funil de prospeccao no periodo. */
apiRouter.get('/resultados', (req, res) => {
  const dias = Math.max(0, Math.min(365, Number(req.query.dias) || 30));
  res.json(metricasCliente(ehAdmin() ? null : usuarioAtual()?.id, dias));
});

// --------------------------------------------------------------- reunioes
apiRouter.get('/reunioes', (req, res) => res.json(listarReunioes(req.usuario.id)));

apiRouter.post(
  '/reunioes',
  wrap(async (req, res) => {
    const { companyId, quando, duracaoMin, titulo, notas } = req.body ?? {};
    if (!companyId) throw new Error('Lead não informado.');
    const reuniao = agendarReuniao({ userId: req.usuario.id, companyId, quando, duracaoMin, titulo, notas });
    res.json(reuniao);
  })
);

apiRouter.patch(
  '/reunioes/:id',
  wrap(async (req, res) => {
    res.json(atualizarReuniao(req.params.id, req.body ?? {}));
  })
);

/** KPIs globais do usuario (topo do painel, visivel em qualquer aba). */
apiRouter.get('/estatisticas', (_req, res) => {
  const f = filtroDoDono();
  const leadsSalvos = one(
    `SELECT COUNT(*) n FROM companies WHERE status<>'novo'${f.sql}`,
    ...f.params
  )?.n ?? 0;
  const fCalls = filtroDoDono();
  const ligacoes = one(`SELECT COUNT(*) n FROM calls WHERE 1=1${fCalls.sql}`, ...fCalls.params)?.n ?? 0;
  const fAtend = filtroDoDono();
  const atendidas = one(
    `SELECT COUNT(*) n FROM calls WHERE is_winner=1${fAtend.sql}`,
    ...fAtend.params
  )?.n ?? 0;
  const custoHoje = resumoDeCustos(ehAdmin() ? null : usuarioAtual()?.id).hoje.usd;

  res.json({
    leadsSalvos,
    ligacoesDisparadas: ligacoes,
    taxaAtendimento: ligacoes ? Math.round((atendidas / ligacoes) * 1000) / 10 : 0,
    custoHojeUsd: custoHoje,
  });
});

// Telefone do vendedor salvo pelo painel: vira o padrao do sistema, entao o
// teste de ligacao e as proximas campanhas ja o usam sem redigitar.
apiRouter.post(
  '/settings/vendedor',
  wrap(async (req, res) => {
    const tel = toE164BR(req.body?.telefone);
    if (!tel || !isPlausiblePhone(tel)) throw new Error('Telefone invalido. Use o formato +5534991234567.');
    setSetting('agent_phone', tel);
    definirVendedorSalvo(tel);
    log('sistema', `telefone do vendedor definido: ${tel}`);
    res.json({ telefone: tel });
  })
);

// ------------------------------------------------------------ prospeccao
apiRouter.post(
  '/search',
  wrap(async (req, res) => {
    conferirLimite(req);
    conferirCotaBusca(req.usuario);
    const { segment, region, quantity } = req.body ?? {};
    if (!segment || !region) throw new Error('Informe segmento e regiao.');
    const searchId = uid('sch_');
    // Roda em background: o painel acompanha pelo WebSocket.
    runSearch({ segment, region, quantity, searchId }).catch(() => {});
    res.status(202).json({ searchId });
  })
);

/**
 * Importa uma planilha (.xlsx ou .csv) como lista de leads.
 * O arquivo chega em base64 no corpo: evita dependencia de upload multipart
 * para algo que e, no fim, um punhado de linhas com nome e telefone.
 */
apiRouter.post(
  '/importar',
  wrap(async (req, res) => {
    const { arquivo, nome } = req.body ?? {};
    if (!arquivo) throw new Error('Nenhum arquivo recebido.');

    const buffer = Buffer.from(String(arquivo).split(',').pop(), 'base64');
    if (buffer.length > 12 * 1024 * 1024) throw new Error('Arquivo muito grande (limite de 12 MB).');

    const { contatos, ignorados, colunas, total } = lerPlanilha(buffer, nome ?? '');
    if (!contatos.length) {
      throw new Error(`Nenhum telefone valido em ${total} linha(s). Confira a coluna de telefone.`);
    }

    const searchId = uid('sch_imp');
    insert('searches', {
      id: searchId,
      segment: `Planilha: ${nome || 'importada'}`,
      region: '-',
      quantity: contatos.length,
      status: 'concluida',
      source: 'planilha',
      log: JSON.stringify({ total, importados: contatos.length, ignorados: ignorados.length, colunas }),
      created_at: nowIso(),
    });

    for (const c of contatos) {
      saveCompany(searchId, {
        ...c,
        source: 'planilha',
        // Veio de lista sua: nao passa pela validacao de "empresa existe?".
        score: 70,
        verdict: 'importada',
        reasons: ['importada da planilha', `coluna de telefone: ${colunas.telefone}`],
        tipoTelefone: tipoTelefone(c.phoneE164),
      });
    }

    const empresas = listCompanies(searchId);
    log('planilha', `${contatos.length} contatos importados de "${nome}" (${ignorados.length} ignorados)`);
    emit('search:done', { searchId, companies: empresas });

    res.json({
      searchId,
      importados: contatos.length,
      ignorados: ignorados.slice(0, 20),
      totalIgnorados: ignorados.length,
      colunas,
      companies: empresas,
    });
  })
);

apiRouter.get('/searches', (_req, res) => {
  const f = filtroDoDono();
  res.json(many('SELECT * FROM searches WHERE 1=1' + f.sql + ' ORDER BY created_at DESC LIMIT 50', ...f.params));
});

apiRouter.get('/searches/:id', (req, res) => {
  const search = one('SELECT * FROM searches WHERE id=?', req.params.id);
  if (!search) return res.status(404).json({ error: 'busca nao encontrada' });
  res.json({ search, companies: listCompanies(req.params.id) });
});

apiRouter.get('/searches/:id/csv', (req, res) => {
  const rows = listCompanies(req.params.id);
  const head = ['nome', 'telefone', 'site', 'instagram', 'email', 'endereco', 'nota', 'avaliacoes', 'score', 'status'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    head.join(','),
    ...rows.map((r) =>
      [r.name, r.phone_e164, r.website, r.instagram, r.email, r.address, r.rating, r.reviews, r.score, r.status]
        .map(esc)
        .join(',')
    ),
  ].join('\n');
  res.type('text/csv').attachment(`empresas-${req.params.id}.csv`).send(csv);
});

// --------------------------------------------------------------- campanhas
apiRouter.post(
  '/campaigns',
  wrap(async (req, res) => {
    conferirLimite(req);
    const { companyIds, name, agentPhone, whatsappFollowup } = req.body ?? {};
    if (!Array.isArray(companyIds) || !companyIds.length) throw new Error('Selecione ao menos uma empresa.');
    conferirCotaLigacoes(req.usuario, companyIds.length);
    const result = await startCampaign({ companyIds, name, agentPhone, whatsappFollowup });
    res.json(result);
  })
);

apiRouter.get('/campaigns', (_req, res) => {
  const f = filtroDoDono();
  res.json(many('SELECT * FROM campaigns WHERE 1=1' + f.sql + ' ORDER BY created_at DESC LIMIT 30', ...f.params));
});

apiRouter.get('/campaigns/:id', (req, res) => {
  const campaign = one('SELECT * FROM campaigns WHERE id=?', req.params.id);
  if (!campaign) return res.status(404).json({ error: 'campanha nao encontrada' });
  const calls = many('SELECT * FROM calls WHERE campaign_id=? ORDER BY created_at ASC', req.params.id).map((c) => ({
    ...c,
    company: getCompany(c.company_id),
    transcript: JSON.parse(c.transcript || '[]'),
  }));
  res.json({ campaign, calls });
});

apiRouter.post(
  '/campaigns/:id/stop',
  wrap(async (req, res) => {
    await engine.stopCampaign(req.params.id);
    res.json({ ok: true });
  })
);

// ------------------------------------------------- simulacao (sem Twilio)
apiRouter.post(
  '/calls/:id/answer',
  wrap(async (req, res) => {
    if (voiceMode() === 'twilio') throw new Error('Disponivel apenas no modo simulacao.');
    const instruction = await engine.onAnswered({ callId: req.params.id, answeredBy: 'human' });
    res.json(instruction);
  })
);

apiRouter.post(
  '/calls/:id/speech',
  wrap(async (req, res) => {
    if (voiceMode() === 'twilio') throw new Error('Disponivel apenas no modo simulacao.');
    const instruction = await engine.onSpeech({ callId: req.params.id, speech: req.body?.speech ?? '' });
    res.json(instruction);
  })
);

apiRouter.post(
  '/calls/:id/accept-agent',
  wrap(async (req, res) => {
    if (voiceMode() === 'twilio') throw new Error('Disponivel apenas no modo simulacao.');
    const instruction = await engine.onAgentAccept({ callId: req.params.id });
    res.json(instruction);
  })
);

apiRouter.get('/calls/:id', (req, res) => {
  const call = one('SELECT * FROM calls WHERE id=?', req.params.id);
  if (!call) return res.status(404).json({ error: 'ligacao nao encontrada' });
  res.json({ ...call, company: getCompany(call.company_id), transcript: JSON.parse(call.transcript || '[]') });
});

// ------------------------------------------------- fila de discagem manual
// Leads salvos que ainda nao foram trabalhados, do melhor score para o pior.
apiRouter.get('/leads', (_req, res) => {
  res.json({
    fila: (() => {
      const f = filtroDoDono();
      return many(
        "SELECT * FROM companies WHERE status='lead'" + f.sql + ' ORDER BY score DESC, name ASC LIMIT 200',
        ...f.params
      );
    })(),
    trabalhados: many(
      `SELECT * FROM companies
       WHERE status IN ('atendeu','nao atendeu','sem interesse','retornar','falando com humano')
       ORDER BY created_at DESC LIMIT 50`
    ),
  });
});

// Mailing pronto para importar em discador de mercado (3C Plus, Olos, Callix...).
// formato=telefones devolve um numero por linha, que todo discador aceita.
apiRouter.get('/leads/csv', (req, res) => {
  const leads = many(
    "SELECT * FROM companies WHERE status IN ('lead','retornar') ORDER BY score DESC, name ASC"
  );
  // Discador brasileiro espera DDD + numero, sem +55 e sem pontuacao.
  const soDigitos = (t) => String(t ?? '').replace(/\D/g, '').replace(/^55/, '');

  if (req.query.formato === 'telefones') {
    return res
      .type('text/plain')
      .attachment('telefones.txt')
      .send(leads.map((c) => soDigitos(c.phone_e164)).filter(Boolean).join('\n'));
  }

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const linhas = [
    'nome,telefone,ddd,numero,cidade,instagram,site,score',
    ...leads.map((c) => {
      const d = soDigitos(c.phone_e164);
      return [c.name, d, d.slice(0, 2), d.slice(2), c.address, c.instagram, c.website, c.score]
        .map(esc)
        .join(',');
    }),
  ];
  res.type('text/csv').attachment('mailing-iasdr.csv').send(linhas.join('\n'));
});

// --------------------------------------------------------------- whatsapp
apiRouter.post(
  '/whatsapp/send',
  wrap(async (req, res) => {
    const { companyId, text, contexto } = req.body ?? {};
    const company = getCompany(companyId);
    if (!company) throw new Error('Empresa nao encontrada.');
    const result = await sendWhatsapp({ company, text, contexto });
    res.json(result);
  })
);

apiRouter.get('/whatsapp/fila', (_req, res) => res.json(statusDaFila()));

apiRouter.get('/whatsapp/threads', (_req, res) => {
  const rows = many(`
    SELECT phone,
           MAX(created_at) AS last_at,
           COUNT(*) AS total,
           (SELECT body FROM messages m2 WHERE m2.phone = m1.phone ORDER BY created_at DESC LIMIT 1) AS last_body,
           (SELECT company_id FROM messages m3 WHERE m3.phone = m1.phone AND company_id IS NOT NULL LIMIT 1) AS company_id
    FROM messages m1 GROUP BY phone ORDER BY last_at DESC LIMIT 50
  `);
  res.json(rows.map((r) => ({ ...r, company: r.company_id ? getCompany(r.company_id) : null })));
});

apiRouter.get('/whatsapp/thread/:phone', (req, res) => {
  res.json(historyOf(req.params.phone));
});

// --------------------------------------------------------------- empresas
apiRouter.patch(
  '/companies/:id',
  wrap(async (req, res) => {
    const allowed = ['status', 'notes', 'phone_e164', 'instagram', 'website', 'email'];
    const patch = Object.fromEntries(Object.entries(req.body ?? {}).filter(([k]) => allowed.includes(k)));
    update('companies', req.params.id, patch);
    const atualizado = getCompany(req.params.id);

    // Lead salvo (ou marcado como atendeu) dispara os CRMs com auto-sync
    // ligado. Nunca trava a resposta: se o CRM falhar, o log registra e a
    // pessoa continua usando o painel normalmente.
    if (patch.status === 'lead' || patch.status === 'atendeu') {
      sincronizarSeAutomatico(req.usuario.id, atualizado.id, atualizado);
    }

    res.json(atualizado);
  })
);

/**
 * Toca/baixa o audio da ligacao vencedora. Proxied pelo nosso servidor (em
 * vez de mandar o link direto da Twilio) porque a URL da Twilio exige as
 * credenciais da conta via Basic Auth - inviavel de expor para quem abre o
 * link. Aqui basta estar logado no IA SDR.
 */
apiRouter.get(
  '/companies/:id/gravacao',
  wrap(async (req, res) => {
    const call = one(
      "SELECT recording_url FROM calls WHERE company_id=? AND recording_url IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      req.params.id
    );
    if (!call?.recording_url) return res.status(404).json({ error: 'Sem gravação para esta empresa.' });

    const token = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
    const upstream = await fetch(call.recording_url, { headers: { Authorization: `Basic ${token}` } });
    if (!upstream.ok || !upstream.body) return res.status(502).json({ error: 'Não consegui buscar a gravação na Twilio.' });

    res.type('audio/mpeg');
    const { Readable } = await import('node:stream');
    Readable.fromWeb(upstream.body).pipe(res);
  })
);
