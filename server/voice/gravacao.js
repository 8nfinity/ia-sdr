/**
 * Gravacao da ligacao vencedora (vendedor + empresa) + transcricao via Twilio
 * Conversational Intelligence + resumo por IA, anexados ao lead e enviados ao
 * CRM automaticamente.
 *
 * Fluxo:
 *  1. twiml-builder.js grava a conferencia (record-from-start) quando a
 *     empresa entra na sala vencedora.
 *  2. A Twilio chama /twiml/recording-status/:callId quando o audio esta
 *     pronto -> onRecordingStatus() guarda o audio e pede a transcricao.
 *  3. A transcricao e assincrona (a Twilio processa por conta propria) ->
 *     fazemos polling ate ficar pronta.
 *  4. Com o texto em maos, a IA escreve um resumo breve (claude.js) e tudo
 *     e gravado na empresa + reenviado ao CRM (mesmo pipeline do lead).
 */
import { config } from '../config.js';
import { one, update, getCompany } from '../db.js';
import { emit, log } from '../realtime.js';
import { summarizeCall } from '../ai/claude.js';
import { sincronizarSeAutomatico } from '../crm/index.js';
import { fetchWithTimeout } from '../util.js';

const INTEL_BASE = 'https://intelligence.twilio.com/v2';

function auth() {
  const token = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
  return { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' };
}

/** Chamada quando a Twilio termina de gravar a ligacao vencedora. */
export async function onRecordingStatus(callId, body) {
  const call = one('SELECT * FROM calls WHERE id=?', callId);
  if (!call) return;
  // A Twilio pode reenviar o mesmo callback; nao reprocessa a toa.
  if (call.recording_sid === body.RecordingSid) return;

  const recordingSid = body.RecordingSid;
  // Defesa em profundidade: so guarda URL da propria Twilio, mesmo que a
  // assinatura do webhook ja tenha sido validada. O proxy de download em
  // api.js confere de novo antes de buscar.
  const base = String(body.RecordingUrl ?? '');
  const recordingUrl = /^https:\/\/api\.twilio\.com\//.test(base) ? `${base}.mp3` : null;
  if (base && !recordingUrl) log('telefonia', `URL de gravacao suspeita ignorada: ${base}`);
  if (body.RecordingStatus && body.RecordingStatus !== 'completed') {
    log('telefonia', `gravacao ${recordingSid ?? ''}: status ${body.RecordingStatus}`);
    return;
  }

  update('calls', callId, { recording_sid: recordingSid, recording_url: recordingUrl });
  // A gravacao ja e util por si so (audio puro), mesmo sem transcricao.
  update('companies', call.company_id, { gravacao_url: `/api/companies/${call.company_id}/gravacao` });
  log('telefonia', `ligacao gravada (${body.RecordingDuration ?? '?'}s) — ${call.company_id}`);
  emit('call:gravacao', { callId, companyId: call.company_id });

  if (!config.twilio.intelligenceSid || !recordingSid) return; // so audio, sem transcricao configurada
  await iniciarTranscricao(callId, recordingSid).catch((err) =>
    log('telefonia', `nao consegui pedir a transcricao: ${err.message}`)
  );
}

async function iniciarTranscricao(callId, recordingSid) {
  const res = await fetchWithTimeout(
    `${INTEL_BASE}/Transcripts`,
    {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        service_sid: config.twilio.intelligenceSid,
        channel: { media_properties: { source_sid: recordingSid } },
      }),
    },
    15000
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message ?? `Twilio Intelligence: HTTP ${res.status}`);

  update('calls', callId, { transcript_sid: data.sid, transcricao_status: data.status ?? 'queued' });
  log('telefonia', `transcricao pedida (${data.sid}), aguardando a Twilio processar...`);
  agendarChecagem(callId, data.sid, 0);
}

const TERMINAIS = ['completed', 'failed', 'canceled'];

/** A transcricao roda do lado da Twilio; checamos de tempos em tempos. */
function agendarChecagem(callId, transcriptSid, tentativa) {
  const ESPERA = 15000;
  const MAX_TENTATIVAS = 40; // ~10 minutos de folga
  setTimeout(async () => {
    try {
      const pronto = await checarTranscricao(callId, transcriptSid);
      if (!pronto && tentativa < MAX_TENTATIVAS) agendarChecagem(callId, transcriptSid, tentativa + 1);
      else if (!pronto) log('telefonia', `transcricao ${transcriptSid} demorou demais - desisti de checar.`);
    } catch (err) {
      log('telefonia', `erro checando transcricao: ${err.message}`);
    }
  }, ESPERA).unref?.();
}

/** Retorna true quando a transcricao chegou a um estado final (pronta ou nao). */
async function checarTranscricao(callId, transcriptSid) {
  const res = await fetchWithTimeout(`${INTEL_BASE}/Transcripts/${transcriptSid}`, { headers: auth() }, 15000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message ?? `HTTP ${res.status}`);
  if (!TERMINAIS.includes(data.status)) return false;

  update('calls', callId, { transcricao_status: data.status });
  if (data.status !== 'completed') {
    log('telefonia', `transcricao ${transcriptSid} terminou como "${data.status}".`);
    return true;
  }

  const texto = await buscarTexto(transcriptSid);
  await finalizarResumo(callId, texto);
  return true;
}

/** Junta as frases da transcricao em um texto corrido, em ordem cronologica. */
async function buscarTexto(transcriptSid) {
  const res = await fetchWithTimeout(`${INTEL_BASE}/Transcripts/${transcriptSid}/Sentences`, { headers: auth() }, 15000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return '';
  const frases = (data.sentences ?? []).slice().sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0));
  const canais = new Set(frases.map((f) => f.media_channel).filter((c) => c != null));
  return frases
    .map((f) => (canais.size > 1 ? `[canal ${f.media_channel}] ${f.transcript}` : f.transcript))
    .join('\n');
}

/** Texto em maos: pede o resumo pra IA e grava tudo na empresa + reenvia ao CRM. */
async function finalizarResumo(callId, transcricaoTexto) {
  const call = one('SELECT * FROM calls WHERE id=?', callId);
  if (!call || !transcricaoTexto?.trim()) return;
  const company = getCompany(call.company_id);
  if (!company) return;

  const resumo = await summarizeCall({ company, transcript: transcricaoTexto });

  update('companies', call.company_id, {
    transcricao_texto: transcricaoTexto,
    resumo_ligacao: resumo,
  });
  log('telefonia', `resumo da ligacao pronto para ${company.name}.`);
  emit('call:resumo', { callId, companyId: call.company_id, resumo });

  // Reenvia ao CRM com o resumo anexado - mesmo pipeline do lead normal,
  // so que agora a empresa ja tem resumo_ligacao/transcricao_texto/gravacao_url.
  const atualizada = getCompany(call.company_id);
  sincronizarSeAutomatico(call.user_id, call.company_id, atualizada);
}
