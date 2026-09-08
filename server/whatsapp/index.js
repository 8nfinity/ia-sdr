import express from 'express';
import { config } from '../config.js';
import { insert, many, update, companyByPhone } from '../db.js';
import { uid, nowIso, toE164BR } from '../util.js';
import { emit, log } from '../realtime.js';
import { currentProvider, parseAnyInbound } from './providers.js';
import { whatsappFirstMessage, whatsappReply, medindo } from '../ai/claude.js';
import {
  enfileirar, registrarEnvio, iniciarFila, detectarOptOut, estaBloqueado, statusDaFila,
} from './protecao.js';

const historyOf = (phone) =>
  many('SELECT * FROM messages WHERE phone=? ORDER BY created_at ASC LIMIT 40', phone);

function record({ companyId, phone, direction, body, providerId, channel = 'whatsapp' }) {
  const row = {
    id: uid('msg_'),
    company_id: companyId ?? null,
    phone,
    direction,
    channel,
    body,
    provider_id: providerId ?? null,
    created_at: nowIso(),
  };
  insert('messages', row);
  emit('whatsapp:message', row);
  return row;
}

/**
 * Envia WhatsApp para uma empresa. Se `text` nao vier, a IA escreve a mensagem
 * de primeiro contato usando o contexto (ex: "ligamos e nao atenderam").
 */
export async function sendWhatsapp({ company, text, contexto, auto = false }) {
  const provider = currentProvider();
  if (!provider) {
    if (auto) return null;
    throw new Error('WhatsApp desativado (WHATSAPP_PROVIDER=none)');
  }
  const to = toE164BR(company?.whatsapp || company?.phone_e164 || company?.phone);
  if (!to) throw new Error(`Empresa ${company?.name ?? ''} sem telefone valido para WhatsApp`);

  if (estaBloqueado(to)) {
    const motivo = `${company?.name ?? to} pediu para nao receber mensagens`;
    if (auto) return null;
    throw new Error(motivo);
  }

  const body =
    text ||
    (await medindo('whatsapp', company?.id ?? null, () => whatsappFirstMessage({ company, contexto })))
      .resultado;

  // Disparo automatico NUNCA sai em rajada: entra na fila com intervalo,
  // teto diario e horario comercial. E assim que o numero nao cai.
  if (auto) {
    const r = enfileirar({ company, phone: to, body });
    if (!r.ok) {
      log('whatsapp', `${company?.name ?? to}: nao enfileirado (${r.motivo})`);
      return null;
    }
    log('whatsapp', `${company?.name ?? to}: mensagem agendada para ${new Date(r.quando).toLocaleTimeString('pt-BR')}`);
    if (company?.id && company.status === 'novo') update('companies', company.id, { status: 'whatsapp na fila' });
    return { to, body, agendadoPara: r.quando };
  }

  // Envio manual (voce clicou em Enviar): vai na hora.
  const providerId = await provider.send(to, body);
  record({ companyId: company?.id, phone: to, direction: 'out', body, providerId });
  if (company?.id && company.status === 'novo') update('companies', company.id, { status: 'whatsapp enviado' });
  log('whatsapp', `mensagem enviada para ${company?.name ?? to}`);
  return { to, body, providerId };
}

// A fila entrega por aqui: um envio de cada vez, no ritmo do modulo de protecao.
registrarEnvio(async (item) => {
  const provider = currentProvider();
  if (!provider) throw new Error('WhatsApp desativado');
  const providerId = await provider.send(item.phone, item.body);
  record({ companyId: item.company_id, phone: item.phone, direction: 'out', body: item.body, providerId });
  if (item.company_id) update('companies', item.company_id, { status: 'whatsapp enviado' });
  log('whatsapp', `mensagem enviada para ${item.phone} (fila)`);
});
iniciarFila();

export const whatsappRouter = express.Router();

// Verificacao do webhook da Meta.
whatsappRouter.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  if (mode === 'subscribe' && token === config.whatsapp.meta.verifyToken) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// Mensagens recebidas (Meta / Evolution / Twilio).
whatsappRouter.post('/', async (req, res) => {
  res.sendStatus(200); // responde rapido: provedores reenviam se demorar
  try {
    const inbound = parseAnyInbound(req.body);
    if (!inbound) return;

    const company = companyByPhone(inbound.from);
    record({
      companyId: company?.id,
      phone: inbound.from,
      direction: 'in',
      body: inbound.text,
      providerId: inbound.providerId,
    });
    log('whatsapp', `recebido de ${company?.name ?? inbound.from}: ${inbound.text.slice(0, 60)}`);
    if (company) update('companies', company.id, { status: 'respondeu whatsapp' });

    // Pediu para parar? Bloqueia para sempre. E o que mais protege o numero:
    // denuncia de quem foi incomodado depois de pedir para parar e o que
    // derruba a conta.
    if (detectarOptOut(inbound.from, inbound.text)) {
      if (company) update('companies', company.id, { status: 'pediu para nao contatar' });
      return;
    }

    if (!config.whatsapp.aiAutoReply) return;

    const history = historyOf(inbound.from).slice(0, -1);
    const { resultado: reply } = await medindo('whatsapp', company?.id ?? inbound.from, () =>
      whatsappReply({ company, history, incoming: inbound.text })
    );
    if (!reply) return;

    const provider = currentProvider();
    const providerId = await provider.send(inbound.from, reply);
    record({ companyId: company?.id, phone: inbound.from, direction: 'out', body: reply, providerId });
  } catch (err) {
    log('whatsapp', `erro no webhook: ${err.message}`);
  }
});

export { historyOf };

export { statusDaFila };
