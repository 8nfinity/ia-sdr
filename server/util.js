import crypto from 'node:crypto';

export const uid = (prefix = '') => prefix + crypto.randomBytes(8).toString('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();

/** Normaliza telefone brasileiro para E.164 (+55DDNNNNNNNNN). Retorna null se invalido. */
export function toE164BR(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return '+' + d;
  if (d.length === 10 || d.length === 11) {
    const ddd = Number(d.slice(0, 2));
    if (ddd < 11 || ddd > 99) return null;
    return '+55' + d;
  }
  if (d.length > 13) return null;
  return null;
}

/** Numero fixo/movel plausivel: DDD valido e nao repetido (ex: 1111111111). */
export function isPlausiblePhone(e164) {
  if (!e164) return false;
  const d = e164.replace(/\D/g, '');
  if (!d.startsWith('55')) return d.length >= 8;
  const local = d.slice(2);
  if (local.length < 10 || local.length > 11) return false;
  const ddd = Number(local.slice(0, 2));
  const validDDD = [11,12,13,14,15,16,17,18,19,21,22,24,27,28,31,32,33,34,35,37,38,41,42,43,44,45,46,47,48,49,51,53,54,55,61,62,63,64,65,66,67,68,69,71,73,74,75,77,79,81,82,83,84,85,86,87,88,89,91,92,93,94,95,96,97,98,99];
  if (!validDDD.includes(ddd)) return false;
  const rest = local.slice(2);
  if (/^(\d)\1+$/.test(rest)) return false;
  if (local.length === 11 && rest[0] !== '9') return false;
  return true;
}

export function normalizeDomain(url) {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeInstagram(value) {
  if (!value) return null;
  let v = String(value).trim();
  const m = v.match(/instagram\.com\/([A-Za-z0-9._]{2,30})/i);
  if (m) v = m[1];
  v = v.replace(/^@/, '').replace(/\/$/, '');
  if (!/^[A-Za-z0-9._]{2,30}$/.test(v)) return null;
  const blocked = ['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'about', 'legal', 'developer'];
  if (blocked.includes(v.toLowerCase())) return null;
  return '@' + v;
}

export const instagramUrl = (handle) =>
  handle ? 'https://instagram.com/' + handle.replace(/^@/, '') : null;

/** Extrai o primeiro objeto/array JSON de um texto (respostas de LLM). */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  const opener = candidate[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === String.fromCharCode(92)) esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === opener) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(candidate.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Executa promessas com limite de concorrencia. */
export async function pMap(items, worker, concurrency = 5) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await worker(items[idx], idx); }
      catch (err) { results[idx] = { __error: err?.message || String(err) }; }
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Fixo ou celular? No Brasil o celular tem 9 digitos apos o DDD e comeca com 9.
 * Importa muito na prospeccao: fixo cai na recepcao, celular cai na mao de
 * alguem - e em empresa pequena, quase sempre na mao do dono.
 */
export function tipoTelefone(e164) {
  const d = String(e164 ?? '').replace(/\D/g, '');
  const local = d.startsWith('55') ? d.slice(2) : d;
  if (local.length === 11 && local[2] === '9') return 'celular';
  if (local.length === 10) return 'fixo';
  return null;
}
