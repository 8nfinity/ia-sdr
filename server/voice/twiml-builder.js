import { config } from '../config.js';
import { escapeXml } from '../util.js';

const VOICE = () => config.voice.ttsVoice;
const wrap = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
const say = (text) =>
  `<Say voice="${escapeXml(VOICE())}" language="pt-BR">${escapeXml(text)}</Say>`;

export const hangupXml = () => wrap('<Hangup/>');

export const sayHangupXml = (text) => wrap(`${say(text)}<Hangup/>`);

/**
 * A IA fala e ja abre o microfone: `<Gather>` com reconhecimento de fala em
 * pt-BR, e o `<Say>` fica DENTRO do Gather para a pessoa poder interromper.
 */
export const talkXml = (text, actionUrl) =>
  wrap(
    `<Gather input="speech" language="pt-BR" speechTimeout="auto" speechModel="phone_call" ` +
      `action="${escapeXml(actionUrl)}" method="POST" actionOnEmptyResult="true">` +
      say(text) +
      `</Gather>`
  );

/** Briefing para o vendedor humano + tecla 1 para entrar na ligacao. */
export const agentPromptXml = (text, actionUrl) =>
  wrap(
    `<Gather input="dtmf" numDigits="1" action="${escapeXml(actionUrl)}" method="POST" timeout="12">` +
      say(text) +
      `</Gather>` +
      say('Nao recebi resposta. Ate mais.')
  );

/**
 * Sala onde vendedor e empresa se encontram.
 *
 * `aguardando` = o vendedor, que entra ANTES e fica esperando. Ele nao inicia a
 * conferencia, entao ouve musica de espera (o padrao da Twilio) em vez de
 * silencio - assim sabe que a linha esta viva. Quando a empresa entra, a
 * conferencia comeca de fato: a musica para, toca um bipe e os dois se falam.
 */
export const conferenceXml = (conference, intro = null, { aguardando = false } = {}) =>
  wrap(
    (intro ? say(intro) : '') +
      `<Dial><Conference startConferenceOnEnter="${aguardando ? 'false' : 'true'}" ` +
      // O bipe toca quando ESTE participante entra, e quem ouve sao os outros.
      // Entao ele vai na perna da EMPRESA: e o vendedor que precisa saber o
      // instante em que tem alguem do outro lado. No vendedor era inutil - ele
      // ouvia um bipe da propria entrada e depois silencio.
      `endConferenceOnExit="true" beep="${aguardando ? 'false' : 'onEnter'}">` +
      escapeXml(conference) +
      `</Conference></Dial>`
  );
