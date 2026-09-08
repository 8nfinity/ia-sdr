/**
 * Protecao do numero de WhatsApp.
 *
 * Disparar varias mensagens de uma vez, para quem nunca falou com voce, no
 * meio da noite e sempre com o mesmo texto e exatamente o padrao que o
 * WhatsApp usa para identificar spam. Este modulo transforma a rajada em um
 * gotejamento com cara de humano:
 *
 *   - fila com intervalo aleatorio entre mensagens (nunca duas juntas)
 *   - teto diario e por hora
 *   - so envia em horario comercial
 *   - nao repete para o mesmo numero dentro do periodo de descanso
 *   - opt-out permanente quando a pessoa pede para parar
 */
import { config } from '../config.js';
import { db, insert, update, one, many } from '../db.js';
import { uid, nowIso } from '../util.js';
import { emit, log } from '../realtime.js';

db.exec(`
CREATE TABLE IF NOT EXISTS wa_fila (
  id TEXT PRIMARY KEY, company_id TEXT, phone TEXT, body TEXT,
  status TEXT, agendado_para TEXT, tentativas INTEGER DEFAULT 0,
  erro TEXT, created_at TEXT, enviado_em TEXT
);
CREATE TABLE IF NOT EXISTS wa_bloqueio (
  phone TEXT PRIMARY KEY, motivo TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_fila_status ON wa_fila(status, agendado_para);
`);

const PEDIDOS_DE_PARADA = [
  'pare', 'parar', 'para de', 'nao quero', 'não quero', 'sair', 'remover',
  'descadastrar', 'nao envie', 'não envie', 'nao me mande', 'não me mande',
  'spam', 'me tira', 'me tire', 'cancelar', 'stop',
];

/** A pessoa pediu para parar? Entao nunca mais. */
export function detectarOptOut(phone, texto) {
  const t = String(texto || '').toLowerCase();
  if (!PEDIDOS_DE_PARADA.some((p) => t.includes(p))) return false;
  bloquear(phone, 'a pessoa pediu para parar de receber mensagens');
  return true;
}

export function bloquear(phone, motivo) {
  db.prepare(
    'INSERT INTO wa_bloqueio (phone, motivo, created_at) VALUES (?,?,?) ON CONFLICT(phone) DO NOTHING'
  ).run(phone, motivo, nowIso());
  log('whatsapp', `${phone} bloqueado: ${motivo}`);
  emit('whatsapp:bloqueio', { phone, motivo });
}

export const estaBloqueado = (phone) => Boolean(one('SELECT 1 FROM wa_bloqueio WHERE phone=?', phone));

/** Ja mandamos mensagem para esse numero recentemente? */
function noDescanso(phone) {
  const dias = config.whatsapp.descansoDias;
  if (!dias) return false;
  const limite = new Date(Date.now() - dias * 86400000).toISOString();
  return Boolean(
    one("SELECT 1 FROM messages WHERE phone=? AND direction='out' AND created_at > ?", phone, limite)
  );
}

const enviadasHoje = () =>
  one(
    "SELECT COUNT(*) n FROM messages WHERE direction='out' AND channel='whatsapp' AND substr(created_at,1,10)=?",
    new Date().toISOString().slice(0, 10)
  )?.n ?? 0;

const enviadasNaUltimaHora = () =>
  one(
    "SELECT COUNT(*) n FROM messages WHERE direction='out' AND channel='whatsapp' AND created_at > ?",
    new Date(Date.now() - 3600000).toISOString()
  )?.n ?? 0;

/** Horario comercial, no fuso do computador. Domingo nunca. */
function dentroDoHorario(quando = new Date()) {
  const dia = quando.getDay();
  const hora = quando.getHours();
  if (dia === 0) return false;
  return hora >= config.whatsapp.horaInicio && hora < config.whatsapp.horaFim;
}

/** Proximo horario util a partir de agora. */
function proximaJanela(quando = new Date()) {
  const d = new Date(quando);
  let voltas = 0;
  while (!dentroDoHorario(d) && voltas < 200) {
    if (d.getHours() >= config.whatsapp.horaFim || d.getDay() === 0) {
      d.setDate(d.getDate() + 1);
      d.setHours(config.whatsapp.horaInicio, Math.floor(Math.random() * 20), 0, 0);
    } else {
      d.setHours(config.whatsapp.horaInicio, Math.floor(Math.random() * 20), 0, 0);
    }
    voltas++;
  }
  return d;
}

/**
 * Coloca a mensagem na fila em vez de disparar na hora.
 * Retorna o motivo da recusa quando o numero nao pode receber.
 */
export function enfileirar({ company, phone, body }) {
  if (estaBloqueado(phone)) return { ok: false, motivo: 'numero bloqueado (pediu para parar)' };
  if (noDescanso(phone)) return { ok: false, motivo: `ja recebeu mensagem nos ultimos ${config.whatsapp.descansoDias} dias` };
  if (one("SELECT 1 FROM wa_fila WHERE phone=? AND status='pendente'", phone))
    return { ok: false, motivo: 'ja esta na fila' };

  // Espaca a partir da ultima mensagem agendada, nunca a partir de agora:
  // assim 10 mensagens viram 10 horarios diferentes, e nao 10 disparos juntos.
  const ultima = one("SELECT agendado_para FROM wa_fila WHERE status='pendente' ORDER BY agendado_para DESC LIMIT 1");
  const base = ultima ? new Date(ultima.agendado_para) : new Date();
  const { intervaloMin, intervaloMax } = config.whatsapp;
  const espera = (intervaloMin + Math.random() * (intervaloMax - intervaloMin)) * 1000;
  const quando = proximaJanela(new Date(Math.max(base.getTime(), Date.now()) + espera));

  const row = insert('wa_fila', {
    id: uid('waq_'),
    company_id: company?.id ?? null,
    phone,
    body,
    status: 'pendente',
    agendado_para: quando.toISOString(),
    tentativas: 0,
    erro: null,
    created_at: nowIso(),
    enviado_em: null,
  });
  emit('whatsapp:fila', { id: row.id, phone, quando: row.agendado_para, empresa: company?.name });
  return { ok: true, quando: row.agendado_para };
}

let despachar = null;
/** O modulo de WhatsApp pluga aqui a funcao que realmente envia. */
export const registrarEnvio = (fn) => { despachar = fn; };

async function processarFila() {
  if (!despachar) return;
  const { limiteDiario, limitePorHora } = config.whatsapp;

  if (!dentroDoHorario()) return;
  if (enviadasHoje() >= limiteDiario) return;
  if (enviadasNaUltimaHora() >= limitePorHora) return;

  const proxima = one(
    "SELECT * FROM wa_fila WHERE status='pendente' AND agendado_para <= ? ORDER BY agendado_para LIMIT 1",
    nowIso()
  );
  if (!proxima) return;

  if (estaBloqueado(proxima.phone)) {
    update('wa_fila', proxima.id, { status: 'cancelada', erro: 'numero bloqueado' });
    return;
  }

  try {
    await despachar(proxima);
    update('wa_fila', proxima.id, { status: 'enviada', enviado_em: nowIso() });
  } catch (err) {
    const tentativas = (proxima.tentativas ?? 0) + 1;
    update('wa_fila', proxima.id, {
      status: tentativas >= 3 ? 'falha' : 'pendente',
      tentativas,
      erro: err.message,
      agendado_para: new Date(Date.now() + 15 * 60000).toISOString(),
    });
    log('whatsapp', `envio falhou (tentativa ${tentativas}): ${err.message}`);
  }
}

export function iniciarFila() {
  setInterval(() => processarFila().catch(() => {}), 20000).unref?.();
}

export const statusDaFila = () => ({
  pendentes: many("SELECT * FROM wa_fila WHERE status='pendente' ORDER BY agendado_para LIMIT 50"),
  enviadasHoje: enviadasHoje(),
  limiteDiario: config.whatsapp.limiteDiario,
  bloqueados: one('SELECT COUNT(*) n FROM wa_bloqueio')?.n ?? 0,
  janela: `${config.whatsapp.horaInicio}h as ${config.whatsapp.horaFim}h, seg a sab`,
  dentroDoHorario: dentroDoHorario(),
});
