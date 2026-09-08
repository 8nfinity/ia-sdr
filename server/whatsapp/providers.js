import { config } from '../config.js';
import { fetchWithTimeout, toE164BR } from '../util.js';

const digits = (e164) => String(e164 || '').replace(/\D/g, '');

/** WhatsApp Cloud API (oficial da Meta). */
const meta = {
  name: 'meta',
  configured: () => Boolean(config.whatsapp.meta.token && config.whatsapp.meta.phoneId),
  async send(to, text) {
    const res = await fetchWithTimeout(
      `https://graph.facebook.com/v21.0/${config.whatsapp.meta.phoneId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.whatsapp.meta.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: digits(to),
          type: 'text',
          text: { body: text },
        }),
      },
      15000
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Meta WhatsApp ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data?.messages?.[0]?.id ?? null;
  },
  parseInbound(body) {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return null;
    return {
      from: toE164BR(msg.from),
      text: msg.text?.body ?? msg.button?.text ?? msg.interactive?.list_reply?.title ?? '',
      providerId: msg.id,
    };
  },
};

/** Evolution API (self-hosted, nao oficial). */
const evolution = {
  name: 'evolution',
  configured: () =>
    Boolean(config.whatsapp.evolution.baseUrl && config.whatsapp.evolution.apiKey && config.whatsapp.evolution.instance),
  async send(to, text) {
    const { baseUrl, apiKey, instance } = config.whatsapp.evolution;
    const res = await fetchWithTimeout(
      `${baseUrl}/message/sendText/${instance}`,
      {
        method: 'POST',
        headers: { apikey: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: digits(to), text }),
      },
      15000
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Evolution ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data?.key?.id ?? null;
  },
  parseInbound(body) {
    const d = body?.data ?? body;
    if (d?.key?.fromMe) return null;
    const jid = d?.key?.remoteJid ?? '';
    const text =
      d?.message?.conversation ??
      d?.message?.extendedTextMessage?.text ??
      d?.message?.imageMessage?.caption ??
      '';
    if (!jid || !text) return null;
    return { from: toE164BR(jid.split('@')[0]), text, providerId: d?.key?.id ?? null };
  },
};

/** WhatsApp via Twilio (sandbox ou numero aprovado). */
const twilioWa = {
  name: 'twilio',
  configured: () => Boolean(config.twilio.accountSid && config.twilio.whatsappFrom),
  async send(to, text) {
    const { default: twilio } = await import('twilio');
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    const msg = await client.messages.create({
      from: config.twilio.whatsappFrom,
      to: `whatsapp:${to}`,
      body: text,
    });
    return msg.sid;
  },
  parseInbound(body) {
    if (!body?.From) return null;
    return {
      from: toE164BR(String(body.From).replace('whatsapp:', '')),
      text: body.Body ?? '',
      providerId: body.MessageSid ?? null,
    };
  },
};

const registry = { meta, evolution, twilio: twilioWa };

export function currentProvider() {
  const name = config.whatsapp.provider;
  if (name === 'none') return null;
  const p = registry[name];
  if (!p) throw new Error(`WHATSAPP_PROVIDER desconhecido: ${name}`);
  if (!p.configured()) throw new Error(`Provedor de WhatsApp "${name}" sem credenciais completas no .env`);
  return p;
}

/** Aceita webhook de qualquer provedor, mesmo que o ativo seja outro. */
export function parseAnyInbound(body) {
  for (const p of [meta, evolution, twilioWa]) {
    try {
      const parsed = p.parseInbound(body);
      if (parsed?.from && parsed.text) return { ...parsed, provider: p.name };
    } catch { /* formato nao bate */ }
  }
  return null;
}
