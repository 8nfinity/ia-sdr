import { fetchWithTimeout, normalizeInstagram, toE164BR, isPlausiblePhone } from '../util.js';
import { extrairCnpj } from './cnpj.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const RE_INSTAGRAM = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{2,30})/gi;
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RE_WHATSAPP = /(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?(\d{10,15})/gi;
const RE_TEL_LINK = /href=["'`]?tel:([+0-9().\s-]{8,20})/gi;
// Exige formatacao de telefone: (34) 3236-7814 / 34 99999-9999 / 3236-7814.
const RE_PHONE_FORMATADO = /(?:\(\d{2}\)|\b\d{2})?[ .]?9?\d{4}[-. ]\d{4}\b/g;
const RE_TITLE = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i;

const IGNORED_EMAIL_DOMAINS = ['sentry.io', 'example.com', 'wixpress.com', 'godaddy.com'];

async function getHtml(url) {
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' }, redirect: 'follow' },
      12000
    );
    if (!res.ok) return { ok: false, status: res.status, html: '' };
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return { ok: true, status: res.status, html: '' };
    const html = (await res.text()).slice(0, 800000);
    return { ok: true, status: res.status, html, finalUrl: res.url };
  } catch (err) {
    return { ok: false, status: 0, html: '', error: err.message };
  }
}

/**
 * Visita o site da empresa (home + paginas de contato) e extrai
 * instagram, e-mail, telefone e WhatsApp. Serve tambem como prova de que
 * a empresa existe de verdade: site que nao responde perde pontos.
 */
export async function enrichFromWebsite(website) {
  const out = {
    siteOk: false,
    siteStatus: 0,
    instagram: null,
    email: null,
    whatsapp: null,
    phoneFromSite: null,
    title: null,
    cnpj: null,
  };
  if (!website) return out;

  const base = website.startsWith('http') ? website : 'https://' + website;
  let origin;
  try {
    origin = new URL(base).origin;
  } catch {
    return out;
  }

  const pages = [base, origin + '/contato', origin + '/contact', origin + '/fale-conosco'];
  const instaCount = new Map();
  let combined = '';

  for (const page of pages) {
    const { ok, status, html } = await getHtml(page);
    if (page === base) {
      out.siteOk = ok && status > 0 && status < 400;
      out.siteStatus = status;
      if (!out.siteOk) break;
      const t = html.match(RE_TITLE);
      if (t) out.title = t[1].replace(/\s+/g, ' ').trim();
    }
    if (!html) continue;
    combined += html;
    if (out.instagram && out.email) break;

    for (const m of html.matchAll(RE_INSTAGRAM)) {
      const handle = normalizeInstagram(m[1]);
      if (handle) instaCount.set(handle, (instaCount.get(handle) ?? 0) + 1);
    }
    if (instaCount.size) {
      out.instagram = [...instaCount.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
    if (!out.email) {
      const emails = [...(html.match(RE_EMAIL) ?? [])].filter(
        (e) => !IGNORED_EMAIL_DOMAINS.some((d) => e.toLowerCase().endsWith(d)) && !/\.(png|jpg|svg|webp)$/i.test(e)
      );
      if (emails.length) out.email = emails[0].toLowerCase();
    }
  }

  if (combined) {
    out.cnpj = extrairCnpj(combined);
    const wa = [...combined.matchAll(RE_WHATSAPP)][0];
    if (wa) out.whatsapp = toE164BR(wa[1]);

    // Ordem de confianca: link "tel:" (o proprio site declarou), depois WhatsApp,
    // e so entao texto solto. Texto solto so vale se estiver FORMATADO como
    // telefone -- (34) 3236-7814 -- senao qualquer sequencia de digitos de um
    // script viraria "telefone" e a ligacao sairia para um numero inexistente.
    const tel = [...combined.matchAll(RE_TEL_LINK)]
      .map((m) => toE164BR(m[1]))
      .find((p) => p && isPlausiblePhone(p));
    const formatado = [...combined.matchAll(RE_PHONE_FORMATADO)]
      .map((m) => toE164BR(m[0]))
      .find((p) => p && isPlausiblePhone(p));

    out.phoneFromSite = tel ?? out.whatsapp ?? formatado ?? null;
  }

  return out;
}
