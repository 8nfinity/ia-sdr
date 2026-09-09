/**
 * Saldo estimado da operação (não é dinheiro do cliente - é o saldo QUE VOCÊ
 * tem nas contas Twilio/Anthropic, para saber se precisa recarregar antes que
 * as ligações/buscas comecem a falhar).
 *
 * Twilio tem uma API de saldo real; a Anthropic não expõe isso, então aqui é
 * uma ESTIMATIVA: você registra quanto recarregou e quando, e o painel
 * subtrai o que a tabela `uso` (que já é exata, é o que gera a cobrança dos
 * clientes) registrou desde então.
 */
import { config } from './config.js';
import { one, getSetting, setSetting } from './db.js';
import { fetchWithTimeout, nowIso } from './util.js';

export async function saldoTwilio() {
  if (!config.twilio.accountSid || !config.twilio.authToken) return null;
  const token = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
  const res = await fetchWithTimeout(
    `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Balance.json`,
    { headers: { Authorization: `Basic ${token}` } },
    10000
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message ?? `Twilio: HTTP ${res.status}`);
  return { saldo: Number(data.balance), moeda: (data.currency ?? 'usd').toUpperCase() };
}

/** Registra uma recarga manual na Anthropic (você digita quando recarrega). */
export function registrarRecargaAnthropic(valorUsd) {
  setSetting('anthropic_recarga_valor', Number(valorUsd) || 0);
  setSetting('anthropic_recarga_data', nowIso());
}

export function saldoAnthropicEstimado() {
  const valor = Number(getSetting('anthropic_recarga_valor', 0)) || 0;
  const dataRecarga = getSetting('anthropic_recarga_data', null);
  if (!valor || !dataRecarga) {
    return { configurado: false, recarregado: 0, dataRecarga: null, gastoDesde: 0, estimado: 0 };
  }
  const gasto = one('SELECT COALESCE(SUM(usd),0) v FROM uso WHERE created_at>=?', dataRecarga)?.v ?? 0;
  return {
    configurado: true,
    recarregado: valor,
    dataRecarga,
    gastoDesde: gasto,
    estimado: Math.max(0, valor - gasto),
  };
}
