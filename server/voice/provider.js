import twilio from 'twilio';
import { config, voiceMode } from '../config.js';
import { emit, log } from '../realtime.js';

let _twilio = null;
export function twilioClient() {
  if (!_twilio) _twilio = twilio(config.twilio.accountSid, config.twilio.authToken);
  return _twilio;
}

export const publicUrl = (path) => `${config.publicBaseUrl}${path}`;

/**
 * O endereco publico esta mesmo no ar?
 *
 * A Twilio disca, a pessoa atende e SO ENTAO ela busca as instrucoes neste
 * endereco. Se ele estiver fora (tunel caiu, endereco mudou), a ligacao cai no
 * segundo seguinte ao "alo" - e voce pagou por ela. Conferir antes custa 3
 * segundos e evita queimar a campanha inteira.
 */
/**
 * TwiML hospedado pela propria Twilio (twimlets), usado como plano B quando o
 * nosso servidor nao responde. Joga a empresa direto na sala do vendedor.
 * Por isso a sala tem nome fixo: um TwiML estatico nao sabe o id da campanha.
 */
export const SALA_FIXA = 'iasdr_sala';
export function salaDeEmergencia() {
  const twiml =
    '<Response><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false">' +
    SALA_FIXA +
    '</Conference></Dial></Response>';
  return 'https://twimlets.com/echo?Twiml=' + encodeURIComponent(twiml);
}

let ultimaChecagem = { quando: 0, ok: false };
export async function checarEnderecoPublico() {
  if (!config.publicBaseUrl) {
    throw new Error(
      'PUBLIC_BASE_URL vazio: a Twilio nao tem para onde mandar os eventos. Rode "npm run tunel" e reinicie o servidor.'
    );
  }
  // Resultado recente serve: nao precisa checar a cada disparo.
  if (Date.now() - ultimaChecagem.quando < 60000 && ultimaChecagem.ok) return true;

  try {
    const res = await fetch(`${config.publicBaseUrl}/health`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    ultimaChecagem = { quando: Date.now(), ok: true };
    return true;
  } catch {
    ultimaChecagem = { quando: Date.now(), ok: false };
    throw new Error(
      `O endereco publico (${config.publicBaseUrl}) nao responde. ` +
        'O tunel caiu ou mudou de endereco. Rode "npm run tunel" e depois reinicie o servidor ("npm start") ' +
        'antes de ligar - senao a ligacao cai assim que a pessoa atender.'
    );
  }
}

/**
 * Provedor real (Twilio).
 * machineDetection sincrono e proposital: a Twilio so pede o TwiML depois de
 * decidir se quem atendeu e humano ou caixa postal, entao uma secretaria
 * eletronica nunca "ganha" a corrida.
 */
const twilioProvider = {
  mode: 'twilio',

  async dial({ callId, to, ringTimeout }) {
    const call = await twilioClient().calls.create({
      to,
      from: config.twilio.from,
      url: publicUrl(`/twiml/answer/${callId}`),
      method: 'POST',
      timeout: ringTimeout,
      // 'Enable' decide no COMECO da fala (2-3s). 'DetectMessageEnd' espera a
      // saudacao inteira acabar - serve para deixar recado, e deixava quem
      // atendeu ouvindo silencio por ate 15 segundos antes de conectar.
      machineDetection: 'Enable',
      machineDetectionTimeout: 6,
      statusCallback: publicUrl(`/twiml/status/${callId}`),
      // So o evento final. Com 10 ligacoes simultaneas, assinar os 4 eventos
      // gerava ~40 requisicoes em segundos - rajada que derruba tunel gratuito
      // (HTTP 502/530) e faz a Twilio desligar quem acabou de atender.
      statusCallbackEvent: ['completed'],
      statusCallbackMethod: 'POST',
      // Rede de seguranca: se o nosso servidor nao responder na hora do "alo",
      // a Twilio usa este TwiML (hospedado por ela) e joga a empresa na sala do
      // vendedor assim mesmo, em vez de desligar na cara da pessoa.
      fallbackUrl: salaDeEmergencia(),
      fallbackMethod: 'GET',
    });
    return call.sid;
  },

  async dialAgent({ callId, campaignId, to }) {
    // Modo direto: a perna do vendedor abre a sala da campanha (lobby).
    // Modo IA: a perna do vendedor e por ligacao, com briefing e tecla 1.
    const rota = campaignId ? `/twiml/lobby/${campaignId}` : `/twiml/agent/${callId}`;
    const call = await twilioClient().calls.create({
      to,
      from: config.twilio.from,
      url: publicUrl(rota),
      method: 'POST',
      timeout: 40,
      statusCallback: publicUrl(`/twiml/agent-status/${campaignId ?? callId}`),
      statusCallbackMethod: 'POST',
    });
    return call.sid;
  },

  async hangup(sid, { canceled = false } = {}) {
    if (!sid) return;
    try {
      await twilioClient().calls(sid).update({ status: canceled ? 'canceled' : 'completed' });
    } catch (err) {
      // 'canceled' so vale enquanto toca; se ja atendeu, encerra.
      if (canceled) {
        try { await twilioClient().calls(sid).update({ status: 'completed' }); } catch { /* ja terminou */ }
      }
    }
  },

  async redirect(sid, xml) {
    if (!sid) return;
    await twilioClient().calls(sid).update({ twiml: xml });
  },
};

/**
 * Provedor simulado: roda todo o fluxo (corrida, vencedor, cancelamento dos
 * outros, handoff) sem ligar de verdade. Serve para testar o sistema antes de
 * ter conta na Twilio. As falas da empresa voce digita no painel.
 */
function simulationProvider(engineRef) {
  const timers = new Map();
  return {
    mode: 'simulation',

    async dial({ callId, to, ringTimeout }) {
      const sid = 'SIM' + callId;
      emit('call:update', { callId, status: 'ringing' });
      const roll = Math.random();
      const delay = 2000 + Math.random() * Math.min(ringTimeout * 1000 - 2000, 8000);
      const t = setTimeout(async () => {
        timers.delete(callId);
        const engine = engineRef();
        if (roll < 0.45) await engine.onAnswered({ callId, answeredBy: 'human' });
        else if (roll < 0.6) await engine.onAnswered({ callId, answeredBy: 'machine_start' });
        else await engine.onStatus({ callId, status: 'no-answer' });
      }, delay);
      timers.set(callId, t);
      return sid;
    },

    async dialAgent({ callId, campaignId }) {
      log('telefonia', 'SIMULACAO: tocando no telefone do vendedor humano...');
      emit('agent:ringing', { callId, campaignId });
      // No modo direto o vendedor atende sozinho na simulacao, e so entao as
      // empresas sao discadas - igual ao fluxo real.
      if (campaignId) {
        setTimeout(() => {
          engineRef().onAgentReady({ campaignId }).catch(() => {});
        }, 1500);
      }
      return 'SIMAGENT' + (campaignId ?? callId);
    },

    async hangup(sid, _opts) {
      const callId = String(sid || '').replace(/^SIM/, '');
      const t = timers.get(callId);
      if (t) { clearTimeout(t); timers.delete(callId); }
    },

    async redirect(_sid, _xml) {
      /* nada a fazer na simulacao */
    },
  };
}

let _provider = null;
export function getProvider(engineRef) {
  if (!_provider) {
    _provider = voiceMode() === 'twilio' ? twilioProvider : simulationProvider(engineRef);
    log('telefonia', `provedor de voz: ${_provider.mode}`);
  }
  return _provider;
}
