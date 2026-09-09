import { config, telefoneDoVendedor } from '../config.js';
import { insert, update, one, many, getCompany, claimWinner } from '../db.js';
import { uid, nowIso } from '../util.js';
import { emit, log } from '../realtime.js';
import { getProvider, checarEnderecoPublico, SALA_FIXA } from './provider.js';
import { generateOpening, sdrTurn, agentBriefing, fallbackOpening, medindo } from '../ai/claude.js';
import { sendWhatsapp } from '../whatsapp/index.js';
import { sincronizarSeAutomatico } from '../crm/index.js';
import { conferenceXml, sayHangupXml } from './twiml-builder.js';

const provider = () => getProvider(() => engine);

// Le sempre do banco: durante a ligacao varias partes escrevem na transcricao,
// e um objeto em memoria desatualizado apagaria o turno anterior.
function readTranscript(callId) {
  const row = one('SELECT transcript FROM calls WHERE id=?', callId);
  try { return JSON.parse(row?.transcript || '[]'); } catch { return []; }
}
function pushTranscript(callId, role, text) {
  const t = readTranscript(callId);
  t.push({ role, text, at: nowIso() });
  update('calls', callId, { transcript: JSON.stringify(t) });
  emit('call:transcript', { callId, role, text });
  return t;
}

/**
 * Nome FIXO da sala.
 *
 * Era `iasdr_<id da campanha>`, mas o TwiML de emergencia (hospedado pela
 * Twilio, usado quando nosso servidor nao responde) e estatico: ele nao tem
 * como saber o id da campanha. Com nome fixo, o plano B cai na mesma sala onde
 * o vendedor esta esperando. So roda uma campanha por vez, entao nao ha colisao.
 */
export const conferenceName = () => SALA_FIXA;

// ---------------------------------------------------------------------------
// Inicio da campanha: liga para TODAS as empresas ao mesmo tempo
// ---------------------------------------------------------------------------
export async function startCampaign({ companyIds, name, agentPhone, whatsappFollowup = true }) {
  const companies = companyIds.map(getCompany).filter(Boolean).filter((c) => c.phone_e164);
  if (!companies.length) throw new Error('Nenhuma empresa com telefone valido foi selecionada.');

  // Antes de gastar a primeira ligacao: a Twilio consegue falar com a gente?
  if (provider().mode === 'twilio') await checarEnderecoPublico();

  const campaignId = uid('cmp');
  const agent = agentPhone || telefoneDoVendedor();

  insert('campaigns', {
    id: campaignId,
    name: name || `Campanha ${new Date().toLocaleString('pt-BR')}`,
    status: 'discando',
    conference: conferenceName(campaignId),
    agent_phone: agent || null,
    winner_call_id: null,
    winner_company_id: null,
    script: null,
    mode: provider().mode,
    modo: config.voice.modo,
    created_at: nowIso(),
    ended_at: null,
  });

  const calls = companies.map((c) =>
    insert('calls', {
      id: uid('cl_'),
      campaign_id: campaignId,
      company_id: c.id,
      to_number: c.phone_e164,
      provider_sid: null,
      status: 'criada',
      answered_by: null,
      is_winner: 0,
      agent_state: 'idle',
      transcript: '[]',
      outcome: null,
      created_at: nowIso(),
      answered_at: null,
      ended_at: null,
    })
  );

  emit('campaign:start', {
    campaignId,
    mode: provider().mode,
    modo: config.voice.modo,
    calls: calls.map((c) => ({
      ...c,
      company: companies.find((x) => x.id === c.company_id),
    })),
  });

  if (whatsappFollowup) scheduleFollowup(campaignId);

  // ---- modo direto: o VENDEDOR entra na linha primeiro ----
  // Disca para ele uma unica vez; assim que atende, as empresas sao chamadas e
  // quem atender cai direto na ligacao dele. Ele nao aperta nada.
  if (config.voice.modo === 'direto') {
    if (!agent) throw new Error('Preencha o telefone do vendedor: e por ele que as ligacoes acontecem.');
    update('campaigns', campaignId, { status: 'chamando vendedor' });
    log('telefonia', `Chamando o vendedor em ${agent}. Quando ele atender, as ${calls.length} empresas serao discadas.`);
    emit('campaign:aguardando-vendedor', { campaignId, agente: agent, empresas: calls.length });

    try {
      const sid = await provider().dialAgent({ campaignId, to: agent });
      update('campaigns', campaignId, { agent_call_sid: sid });
    } catch (err) {
      update('campaigns', campaignId, { status: 'erro', ended_at: nowIso() });
      emit('campaign:erro', { campaignId, message: `nao consegui ligar para o vendedor: ${err.message}` });
      throw err;
    }

    // Vendedor nao atendeu: nao faz sentido incomodar as empresas.
    setTimeout(() => {
      const c = one('SELECT * FROM campaigns WHERE id=?', campaignId);
      if (c?.status === 'chamando vendedor') {
        log('telefonia', 'O vendedor nao atendeu. Campanha cancelada, nenhuma empresa foi chamada.');
        update('campaigns', campaignId, { status: 'finalizada', ended_at: nowIso() });
        for (const call of many("SELECT * FROM calls WHERE campaign_id=? AND status='criada'", campaignId)) {
          update('calls', call.id, { status: 'encerrada', outcome: 'vendedor nao atendeu', ended_at: nowIso() });
          emit('call:update', { callId: call.id, status: 'encerrada', detail: 'vendedor nao atendeu' });
        }
        emit('campaign:end', { campaignId, motivo: 'vendedor nao atendeu' });
      }
    }, config.voice.esperaVendedor * 1000).unref?.();

    return { campaignId, calls: calls.length, aguardandoVendedor: true };
  }

  // ---- modo ia: a IA atende primeiro e depois transfere ----
  await dispararEmpresas(campaignId);
  return { campaignId, calls: calls.length };
}

/**
 * Rede de seguranca: se um aviso de status da Twilio se perder no caminho, a
 * campanha ficaria "discando" para sempre e o vendedor presto na linha. Depois
 * do tempo maximo de toque (com folga), fecha o que sobrou.
 */
function agendarFechamento(campaignId) {
  const limite = (config.voice.ringTimeout + 25) * 1000;
  setTimeout(async () => {
    const campaign = one('SELECT * FROM campaigns WHERE id=?', campaignId);
    if (!campaign || campaign.winner_call_id || campaign.status === 'finalizada') return;

    const pendentes = many(
      `SELECT * FROM calls WHERE campaign_id=? AND status NOT IN ('encerrada','no-answer','ocupado','falha','voicemail')`,
      campaignId
    );
    for (const c of pendentes) {
      await provider().hangup(c.provider_sid, { canceled: true }).catch(() => {});
      update('calls', c.id, { status: 'no-answer', outcome: 'nao atendeu no tempo', ended_at: nowIso() });
      emit('call:update', { callId: c.id, status: 'no-answer' });
    }
    await encerrarSeNinguemAtendeu(campaignId);
  }, limite).unref?.();
}

/** Dispara todas as ligacoes da campanha em paralelo, de verdade. */
async function dispararEmpresas(campaignId) {
  const calls = many("SELECT * FROM calls WHERE campaign_id=? AND status='criada'", campaignId);
  update('campaigns', campaignId, { status: 'discando' });
  log('telefonia', `Discando para ${calls.length} empresas ao mesmo tempo.`);

  agendarFechamento(campaignId);

  await Promise.all(
    calls.map(async (call) => {
      try {
        const sid = await provider().dial({
          callId: call.id,
          to: call.to_number,
          ringTimeout: config.voice.ringTimeout,
        });
        update('calls', call.id, { provider_sid: sid, status: 'discando' });
        emit('call:update', { callId: call.id, status: 'discando' });
      } catch (err) {
        update('calls', call.id, { status: 'falha', outcome: err.message });
        emit('call:update', { callId: call.id, status: 'falha', detail: err.message });
        log('telefonia', `falha ao discar ${call.to_number}: ${err.message}`);
      }
    })
  );
}

/** Ao fim da corrida, quem nao atendeu recebe WhatsApp (se configurado). */
function scheduleFollowup(campaignId) {
  const wait = (config.voice.ringTimeout + 25) * 1000;
  setTimeout(async () => {
    if (config.whatsapp.provider === 'none') return;
    const perdidas = many(
      "SELECT * FROM calls WHERE campaign_id=? AND is_winner=0 AND status IN ('no-answer','busy','falha','encerrada','voicemail')",
      campaignId
    );
    for (const call of perdidas) {
      const company = getCompany(call.company_id);
      if (!company) continue;
      try {
        await sendWhatsapp({
          company,
          contexto: 'ligamos agora e nao conseguimos falar',
          auto: true,
        });
      } catch (err) {
        log('whatsapp', `follow-up falhou para ${company.name}: ${err.message}`);
      }
    }
  }, wait).unref?.();
}

// ---------------------------------------------------------------------------
// A corrida: primeiro humano que atende leva; os outros sao derrubados
// ---------------------------------------------------------------------------
async function cancelOthers(campaignId, winnerCallId) {
  const others = many(
    "SELECT * FROM calls WHERE campaign_id=? AND id<>? AND status NOT IN ('encerrada','no-answer','falha')",
    campaignId,
    winnerCallId
  );
  await Promise.all(
    others.map(async (call) => {
      try {
        await provider().hangup(call.provider_sid, { canceled: true });
      } catch { /* ja caiu */ }
      update('calls', call.id, {
        status: 'encerrada',
        outcome: 'cancelada: outra empresa atendeu primeiro',
        ended_at: nowIso(),
      });
      emit('call:update', { callId: call.id, status: 'encerrada', detail: 'cancelada pela corrida' });
    })
  );
  log('telefonia', `${others.length} ligacoes encerradas: a corrida ja tem vencedor.`);
}

const TERMINADOS = ['encerrada', 'no-answer', 'ocupado', 'falha', 'voicemail'];

/**
 * Todas as ligacoes acabaram e ninguem atendeu? Entao a campanha acabou.
 *
 * Sem isto o vendedor fica presto numa sala vazia ouvindo silencio (foi o que
 * aconteceu: 3 minutos na linha depois de as 3 empresas ja terem caido) e o
 * painel segue dizendo "discando" para sempre.
 */
async function encerrarSeNinguemAtendeu(campaignId) {
  const campaign = one('SELECT * FROM campaigns WHERE id=?', campaignId);
  if (!campaign || campaign.winner_call_id || campaign.status === 'finalizada') return;

  const calls = many('SELECT * FROM calls WHERE campaign_id=?', campaignId);
  if (!calls.length || !calls.every((c) => TERMINADOS.includes(c.status))) return;

  update('campaigns', campaignId, { status: 'finalizada', ended_at: nowIso() });
  log('telefonia', 'Ninguem atendeu. Encerrando a campanha e liberando o vendedor.');

  // Avisa o vendedor por voz antes de desligar: melhor que silencio.
  if (campaign.agent_call_sid) {
    try {
      await provider().redirect(
        campaign.agent_call_sid,
        sayHangupXml('Ninguem atendeu desta vez. Encerrando a chamada.')
      );
    } catch (err) {
      log('telefonia', `nao consegui avisar o vendedor: ${err.message}`);
    }
  }
  emit('campaign:end', { campaignId, motivo: 'ninguem atendeu' });
}

export const engine = {
  /**
   * Alguem atendeu. Decide: caixa postal (derruba), perdedor da corrida
   * (mensagem curta e desliga) ou VENCEDOR (IA comeca a falar).
   */
  async onAnswered({ callId, answeredBy }) {
    const call = one('SELECT * FROM calls WHERE id=?', callId);
    if (!call) return { type: 'hangup' };
    const company = getCompany(call.company_id);

    // Secretaria eletronica nunca vence a corrida.
    if (answeredBy && /^(machine|fax)/.test(answeredBy)) {
      update('calls', callId, {
        status: 'voicemail',
        answered_by: answeredBy,
        ended_at: nowIso(),
        outcome: 'caixa postal',
      });
      log('telefonia', `${company?.name ?? call.to_number} caiu na caixa postal.`);
      // Evento proprio (alem do call:update) para o painel poder mostrar um
      // aviso destacado, sem precisar adivinhar a partir do status genérico.
      emit('call:voicemail', { callId, company });
      emit('call:update', { callId, status: 'voicemail' });
      return { type: 'hangup' };
    }

    const won = claimWinner(call.campaign_id, callId, call.company_id);

    if (!won) {
      update('calls', callId, {
        status: 'encerrada',
        answered_by: answeredBy ?? 'human',
        ended_at: nowIso(),
        outcome: 'atendeu, mas outra empresa atendeu antes',
      });
      emit('call:update', { callId, status: 'encerrada', detail: 'perdeu a corrida' });
      return { type: 'say_hangup', text: config.voice.courtesyHangup };
    }

    // ---- vencedor ----
    update('calls', callId, {
      status: 'atendida',
      answered_by: answeredBy ?? 'human',
      is_winner: 1,
      answered_at: nowIso(),
    });
    update('companies', call.company_id, { status: 'atendeu' });
    emit('call:winner', { callId, campaignId: call.campaign_id, company });
    log('telefonia', `ATENDEU: ${company?.name}. Encerrando as outras ligacoes.`);

    // Quem atendeu vale a pena mandar pro CRM na hora, nao so quando salvo
    // como lead. Falha de CRM nunca pode atrapalhar a ligacao em andamento.
    sincronizarSeAutomatico(call.user_id, call.company_id, { ...company, status: 'atendeu' });

    // Derruba as demais imediatamente.
    cancelOthers(call.campaign_id, callId).catch(() => {});

    // Modo direto: o vendedor ja esta na linha. A empresa entra na conversa
    // dele na hora, sem IA falando e sem ninguem apertar tecla nenhuma.
    if (config.voice.modo === 'direto') {
      update('calls', callId, { agent_state: 'bridged', status: 'com humano' });
      update('companies', call.company_id, { status: 'falando com humano' });
      emit('call:handoff', { callId, conference: conferenceName(call.campaign_id), direto: true });
      log('telefonia', `${company?.name} conectada ao vendedor.`);
      return { type: 'conference', conference: conferenceName(call.campaign_id) };
    }

    // Modo IA: a IA fala primeiro e chama o vendedor em paralelo.
    this.callHumanAgent({ callId }).catch((err) => log('telefonia', `handoff: ${err.message}`));

    const search = company ? one('SELECT * FROM searches WHERE id=?', company.search_id) : null;
    let opening;
    try {
      const medido = await medindo('ligacao', callId, () =>
        generateOpening({ company, segment: search?.segment })
      );
      opening = medido.resultado;
    } catch {
      opening = fallbackOpening(company);
    }
    pushTranscript(call.id, 'assistant', opening);
    emit('call:say', { callId, text: opening });
    return { type: 'talk', text: opening, callId };
  },

  /** Um turno de fala da pessoa que atendeu. */
  async onSpeech({ callId, speech }) {
    const call = one('SELECT * FROM calls WHERE id=?', callId);
    if (!call) return { type: 'hangup' };
    const company = getCompany(call.company_id);

    // Humano ja entrou: a IA sai de cena.
    if (call.agent_state === 'bridged') {
      return { type: 'conference', conference: conferenceName(call.campaign_id), text: null };
    }

    const transcript = readTranscript(call.id);

    if (!speech || !speech.trim()) {
      const silencios = transcript.filter((t) => t.role === 'system' && t.text === 'sem resposta').length;
      if (silencios >= 2) {
        update('calls', callId, { status: 'encerrada', outcome: 'sem resposta', ended_at: nowIso() });
        return { type: 'say_hangup', text: 'Nao consegui te ouvir. Vou tentar de novo mais tarde, obrigado!' };
      }
      pushTranscript(call.id, 'system', 'sem resposta');
      return { type: 'talk', text: 'Alo? Consegue me ouvir?', callId };
    }

    pushTranscript(call.id, 'user', speech);

    // Cada turno custa reconhecimento de voz + IA. Passou do limite, a IA para
    // de qualificar: ou entrega para o humano, ou encerra com educacao.
    const turnos = readTranscript(call.id).filter((t) => t.role === 'user').length;
    if (turnos > config.voice.maxTurnos) {
      const temHumano = call.agent_state !== 'idle';
      const texto = temHumano
        ? 'So um instante que o especialista ja entra na linha.'
        : 'Perfeito. Vou pedir para um especialista te retornar, obrigado pelo tempo!';
      pushTranscript(call.id, 'assistant', texto);
      if (!temHumano) {
        update('calls', callId, { status: 'encerrada', outcome: 'limite de turnos da IA', ended_at: nowIso() });
        return { type: 'say_hangup', text: texto };
      }
      return { type: 'talk', text: texto, callId };
    }

    let turn;
    try {
      const medido = await medindo('ligacao', callId, () =>
        sdrTurn({ company, transcript: readTranscript(call.id), speech })
      );
      turn = medido.resultado;
    } catch (err) {
      log('ia', `turno falhou: ${err.message}`);
      turn = { reply: 'Entendi. So um instante que vou te passar para um especialista.', action: 'transferir' };
    }

    pushTranscript(call.id, 'assistant', turn.reply);
    emit('call:say', { callId, text: turn.reply, action: turn.action, interesse: turn.interesse });
    if (turn.resumo) update('calls', callId, { outcome: turn.resumo });

    if (turn.action === 'encerrar') {
      update('calls', callId, { status: 'encerrada', ended_at: nowIso() });
      update('companies', call.company_id, { status: 'sem interesse' });
      return { type: 'say_hangup', text: turn.reply };
    }

    if (turn.action === 'whatsapp') {
      const c = getCompany(call.company_id);
      sendWhatsapp({ company: c, contexto: 'pediu material pelo WhatsApp durante a ligacao', auto: true }).catch(
        (err) => log('whatsapp', err.message)
      );
      update('companies', call.company_id, { status: 'whatsapp enviado' });
    }

    if (turn.action === 'transferir' && call.agent_state === 'idle') {
      this.callHumanAgent({ callId }).catch(() => {});
    }

    return { type: 'talk', text: turn.reply, callId };
  },

  /**
   * Modo direto: o vendedor atendeu. Ele entra na sala e SO ENTAO as empresas
   * sao discadas — assim ninguem atende no vazio.
   */
  async onAgentReady({ campaignId }) {
    const campaign = one('SELECT * FROM campaigns WHERE id=?', campaignId);
    if (!campaign) return { type: 'hangup' };
    const conference = conferenceName(campaignId);

    if (campaign.status === 'chamando vendedor') {
      log('telefonia', 'Vendedor na linha. Disparando as ligacoes agora.');
      emit('campaign:vendedor-pronto', { campaignId });
      dispararEmpresas(campaignId).catch((err) => log('telefonia', `falha ao discar: ${err.message}`));
    }

    const total = one('SELECT COUNT(*) n FROM calls WHERE campaign_id=?', campaignId)?.n ?? 0;
    return {
      type: 'conference',
      conference,
      // aguardando: o vendedor entra em espera (com musica) e a conferencia so
      // comeca quando a empresa entra - avisada por um bipe.
      aguardando: true,
      // Curto de proposito: enquanto o vendedor ouve isso, ele ainda NAO esta
      // na sala. Uma mensagem longa fazia empresa que atende rapido cair numa
      // sala vazia. Ao entrar, ele ouve musica; um bipe avisa quando a empresa
      // chega.
      text: `Aguarde. Chamando ${total} empresas.`,
    };
  },

  /** Liga para o vendedor humano para ele assumir. */
  async callHumanAgent({ callId }) {
    const call = one('SELECT * FROM calls WHERE id=?', callId);
    if (!call || call.agent_state !== 'idle') return;
    const campaign = one('SELECT * FROM campaigns WHERE id=?', call.campaign_id);
    const to = campaign?.agent_phone || telefoneDoVendedor();
    if (!to) {
      log('telefonia', 'HUMAN_AGENT_PHONE nao configurado: a IA segue sozinha na ligacao.');
      return;
    }
    update('calls', callId, { agent_state: 'ringing' });
    emit('call:update', { callId, agentState: 'ringing' });
    log('telefonia', `Chamando o vendedor humano em ${to} para assumir.`);
    try {
      const sid = await provider().dialAgent({ callId, to });
      emit('agent:dialing', { callId, sid, to });
    } catch (err) {
      update('calls', callId, { agent_state: 'idle' });
      throw err;
    }
  },

  /** O vendedor atendeu: ouve o briefing e aperta 1 para entrar. */
  async onAgentAnswered({ callId }) {
    const call = one('SELECT * FROM calls WHERE id=?', callId);
    if (!call) return { type: 'hangup' };
    const company = getCompany(call.company_id);
    const briefing = await agentBriefing({ company, transcript: readTranscript(call.id) });
    return {
      type: 'agent_prompt',
      text: `${briefing} Aperte 1 para entrar na ligacao.`,
      callId,
    };
  },

  /** Ponte: a IA sai, o humano entra na mesma ligacao. */
  async onAgentAccept({ callId }) {
    const call = one('SELECT * FROM calls WHERE id=?', callId);
    if (!call) return { type: 'hangup' };
    const conference = conferenceName(call.campaign_id);

    update('calls', callId, { agent_state: 'bridged', status: 'com humano' });
    update('companies', call.company_id, { status: 'falando com humano' });
    emit('call:handoff', { callId, conference });
    log('telefonia', 'HANDOFF: IA saiu, vendedor humano esta na linha.');

    // Puxa a ligacao da empresa para a sala de conferencia onde o humano esta.
    try {
      await provider().redirect(
        call.provider_sid,
        conferenceXml(conference, 'Vou te passar para o especialista agora, um instante.')
      );
    } catch (err) {
      log('telefonia', `nao consegui transferir a ligacao: ${err.message}`);
    }

    return { type: 'conference', conference };
  },

  /** Eventos de status vindos do provedor. */
  async onStatus({ callId, status }) {
    const call = one('SELECT * FROM calls WHERE id=?', callId);
    if (!call) return;
    const map = {
      initiated: 'discando',
      ringing: 'chamando',
      'in-progress': call.is_winner ? 'atendida' : call.status,
      answered: 'atendida',
      completed: 'encerrada',
      busy: 'ocupado',
      failed: 'falha',
      'no-answer': 'no-answer',
      canceled: 'encerrada',
    };
    const next = map[status] ?? status;
    const finished = ['encerrada', 'ocupado', 'falha', 'no-answer'].includes(next);
    update('calls', callId, {
      status: next,
      ...(finished ? { ended_at: nowIso() } : {}),
    });
    emit('call:update', { callId, status: next });

    if (finished && call.is_winner) {
      update('campaigns', call.campaign_id, { status: 'finalizada', ended_at: nowIso() });
      emit('campaign:end', { campaignId: call.campaign_id });
    } else if (finished) {
      // Foi a ultima ligacao em pe? Entao ninguem atendeu e a campanha acabou.
      await encerrarSeNinguemAtendeu(call.campaign_id);
    }
  },

  /** Encerra a campanha inteira manualmente. */
  async stopCampaign(campaignId) {
    const campaign = one('SELECT * FROM campaigns WHERE id=?', campaignId);
    const calls = many("SELECT * FROM calls WHERE campaign_id=? AND status NOT IN ('encerrada')", campaignId);
    await Promise.all(calls.map((c) => provider().hangup(c.provider_sid, { canceled: true }).catch(() => {})));

    // Derrubar as empresas e deixar o vendedor pendurado na sala vazia seria
    // pior que nao encerrar nada.
    if (campaign?.agent_call_sid) {
      await provider().hangup(campaign.agent_call_sid).catch(() => {});
    }
    for (const c of calls) {
      update('calls', c.id, { status: 'encerrada', ended_at: nowIso(), outcome: 'encerrada manualmente' });
    }
    update('campaigns', campaignId, { status: 'finalizada', ended_at: nowIso() });
    emit('campaign:end', { campaignId });
  },
};
