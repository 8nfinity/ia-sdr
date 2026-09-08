import { isPlausiblePhone, normalizeDomain } from '../util.js';

/** Dominios que quase sempre indicam agregador/diretorio, nao a empresa em si. */
const AGGREGATOR_DOMAINS = [
  'ifood.com.br', 'facebook.com', 'instagram.com', 'linkedin.com', 'linktr.ee',
  'google.com', 'business.site', 'wa.me', 'booking.com', 'tripadvisor.com',
  'olx.com.br', 'mercadolivre.com.br', 'gettyimages.com', 'doctoralia.com.br',
  'apontador.com.br', 'telelistas.net', 'guiamais.com.br', 'solutudo.com.br',
  'econodata.com.br', 'cnpj.biz', 'empresascnpj.com', 'yelp.com', 'foursquare.com',
];

/**
 * Score tecnico (0-100) de "essa empresa e real e alcancavel?".
 * Nao usa IA: sao sinais duros, verificaveis.
 */
export function scoreCompany(c) {
  const reasons = [];
  let score = 0;

  // Telefone: sem telefone o SDR nao existe.
  if (c.phoneE164 && isPlausiblePhone(c.phoneE164)) {
    score += 35;
    reasons.push('telefone valido');
  } else {
    reasons.push('sem telefone valido');
  }

  // Site proprio que responde.
  const domain = normalizeDomain(c.website);
  const isAggregator = domain && AGGREGATOR_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
  if (domain && !isAggregator) {
    score += c.siteOk ? 20 : 8;
    reasons.push(c.siteOk ? 'site proprio no ar' : 'site cadastrado (nao respondeu)');
  } else if (isAggregator) {
    reasons.push('site e agregador/rede social, nao proprio');
  } else {
    reasons.push('sem site');
  }

  // Instagram ativo.
  if (c.instagram) {
    score += 12;
    reasons.push('instagram encontrado');
  }

  // Prova social no Maps.
  const reviews = Number(c.reviews ?? 0);
  if (reviews >= 50) {
    score += 20;
    reasons.push(`${reviews} avaliacoes no Maps`);
  } else if (reviews >= 10) {
    score += 14;
    reasons.push(`${reviews} avaliacoes no Maps`);
  } else if (reviews > 0) {
    score += 7;
    reasons.push(`${reviews} avaliacoes no Maps`);
  }

  if (c.rating && Number(c.rating) >= 4) {
    score += 5;
    reasons.push(`nota ${c.rating}`);
  }

  // Endereco fisico.
  if (c.address && c.address.length > 15) {
    score += 8;
    reasons.push('endereco completo');
  }

  // E-mail publico.
  if (c.email) {
    score += 5;
    reasons.push('e-mail publico');
  }

  // Busca por IA nao traz avaliacoes do Maps, entao nao pode ser punida por
  // isso: o que conta como prova aqui e a fonte que a IA citou.
  if (c.source === 'claude-web-search' && c.notes && !reviews) {
    score += 8;
    reasons.push('fonte citada pela IA');
  }

  // Celular chega na pessoa; fixo chega na recepcao.
  if (c.celularResponsavel || c.celularPublicado) {
    score += 10;
    reasons.push('celular do responsavel (CNPJ de empresa pequena)');
  } else if (c.tipoTelefone === 'celular') {
    score += 6;
    reasons.push('celular direto (nao passa por recepcao)');
  }

  // Situacao cadastral e a prova documental mais forte que existe.
  if (c.situacao) {
    if (c.receitaAtiva) {
      score += 12;
      reasons.push('CNPJ ativo na Receita');
      if (c.decisor) reasons.push('socio: ' + c.decisor);
    } else {
      score -= 70;
      reasons.push('CNPJ ' + c.situacao + ' na Receita');
    }
  }

  if (c.businessStatus && c.businessStatus !== 'OPERATIONAL') {
    score -= 60;
    reasons.push(`status no Maps: ${c.businessStatus}`);
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score,
    reasons,
    isAggregator: Boolean(isAggregator),
    // Corte tecnico: precisa de telefone discavel e de algum sinal de existencia.
    passes:
      Boolean(c.phoneE164 && isPlausiblePhone(c.phoneE164)) &&
      score >= 45 &&
      (!c.businessStatus || c.businessStatus === 'OPERATIONAL'),
  };
}

/** Remove duplicatas por telefone, dominio e nome+endereco. */
export function dedupe(list) {
  const seenPhone = new Set();
  const seenDomain = new Set();
  const seenName = new Set();
  const out = [];
  for (const c of list) {
    const domain = normalizeDomain(c.website);
    const nameKey = (c.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') +
      '|' + (c.address ?? '').toLowerCase().slice(0, 20).replace(/[^a-z0-9]/g, '');
    if (c.phoneE164 && seenPhone.has(c.phoneE164)) continue;
    if (domain && !AGGREGATOR_DOMAINS.includes(domain) && seenDomain.has(domain)) continue;
    if (nameKey.length > 4 && seenName.has(nameKey)) continue;
    if (c.phoneE164) seenPhone.add(c.phoneE164);
    if (domain) seenDomain.add(domain);
    seenName.add(nameKey);
    out.push(c);
  }
  return out;
}
