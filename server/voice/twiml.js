import express from 'express';
import twilio from 'twilio';
import { config, voiceMode } from '../config.js';
import { log } from '../realtime.js';
import { engine } from './campaign.js';
import { publicUrl } from './provider.js';
import { hangupXml, sayHangupXml, talkXml, agentPromptXml, conferenceXml } from './twiml-builder.js';
import { onRecordingStatus } from './gravacao.js';

export const twimlRouter = express.Router();

/** Valida que o webhook veio mesmo da Twilio (ative em producao). */
function verifyTwilio(req, res, next) {
  if (!config.twilio.validateSignature || voiceMode() !== 'twilio') return next();
  const signature = req.get('X-Twilio-Signature');
  const url = publicUrl(req.originalUrl);
  const valid = twilio.validateRequest(config.twilio.authToken, signature, url, req.body || {});
  if (!valid) {
    log('telefonia', `assinatura invalida em ${req.originalUrl}`);
    return res.status(403).send('assinatura invalida');
  }
  next();
}

const xml = (res, body) => res.type('text/xml').send(body);

/** Converte a instrucao do motor em TwiML. */
function render(res, instruction, callId) {
  switch (instruction?.type) {
    case 'talk':
      return xml(res, talkXml(instruction.text, publicUrl(`/twiml/turn/${callId}`)));
    case 'say_hangup':
      return xml(res, sayHangupXml(instruction.text));
    case 'conference':
      return xml(res, conferenceXml(instruction.conference, instruction.text, {
        aguardando: instruction.aguardando === true,
        // So a perna que INICIA a sala (aguardando=false, ou seja, a empresa
        // entrando na ligacao vencedora) pede a gravacao - e a mesma que ja
        // dispara "startConferenceOnEnter", entao a sala so existe quando ela
        // entra de qualquer forma.
        gravar:
          config.voice.gravarLigacoes && instruction.aguardando !== true && callId
            ? { callbackUrl: publicUrl(`/twiml/recording-status/${callId}`) }
            : null,
      }));
    case 'agent_prompt':
      return xml(res, agentPromptXml(instruction.text, publicUrl(`/twiml/agent-accept/${callId}`)));
    case 'hangup':
    default:
      return xml(res, hangupXml());
  }
}

// Empresa atendeu (a Twilio ja informa se foi humano ou caixa postal).
twimlRouter.post('/answer/:callId', verifyTwilio, async (req, res) => {
  const { callId } = req.params;
  try {
    const instruction = await engine.onAnswered({ callId, answeredBy: req.body?.AnsweredBy });
    render(res, instruction, callId);
  } catch (err) {
    log('telefonia', `erro no answer: ${err.message}`);
    xml(res, hangupXml());
  }
});

// Cada turno de fala da pessoa.
twimlRouter.post('/turn/:callId', verifyTwilio, async (req, res) => {
  const { callId } = req.params;
  try {
    const instruction = await engine.onSpeech({ callId, speech: req.body?.SpeechResult ?? '' });
    render(res, instruction, callId);
  } catch (err) {
    log('telefonia', `erro no turn: ${err.message}`);
    xml(res, sayHangupXml('Tivemos um problema na ligacao. Retornamos em seguida, obrigado.'));
  }
});

// Modo direto: vendedor atendeu -> entra na sala e as empresas sao discadas.
twimlRouter.post('/lobby/:campaignId', verifyTwilio, async (req, res) => {
  const instruction = await engine.onAgentReady({ campaignId: req.params.campaignId });
  render(res, instruction, req.params.campaignId);
});

// Vendedor humano atendeu -> briefing + tecla 1.
twimlRouter.post('/agent/:callId', verifyTwilio, async (req, res) => {
  const { callId } = req.params;
  const instruction = await engine.onAgentAnswered({ callId });
  render(res, instruction, callId);
});

// Vendedor apertou 1 -> entra na conferencia, IA sai.
twimlRouter.post('/agent-accept/:callId', verifyTwilio, async (req, res) => {
  const { callId } = req.params;
  if (req.body?.Digits !== '1') return xml(res, sayHangupXml('Ok, nao vou transferir. Ate mais.'));
  const instruction = await engine.onAgentAccept({ callId });
  render(res, instruction, callId);
});

// Status das ligacoes.
twimlRouter.post('/status/:callId', verifyTwilio, async (req, res) => {
  await engine.onStatus({ callId: req.params.callId, status: req.body?.CallStatus });
  res.sendStatus(204);
});

twimlRouter.post('/agent-status/:callId', verifyTwilio, (req, res) => {
  log('telefonia', `perna do vendedor: ${req.body?.CallStatus}`);
  res.sendStatus(204);
});

// A gravacao da ligacao vencedora terminou: guarda o audio e dispara a
// transcricao (se configurada). Nunca falha a resposta por causa disso - a
// gravacao ja aconteceu de qualquer forma, isso aqui e so contabilidade.
twimlRouter.post('/recording-status/:callId', verifyTwilio, async (req, res) => {
  res.sendStatus(204);
  try {
    await onRecordingStatus(req.params.callId, req.body || {});
  } catch (err) {
    log('telefonia', `erro ao processar gravacao: ${err.message}`);
  }
});
