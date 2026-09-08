import { config, hasAI } from '../config.js';
import { insert, update, saveCompany, listCompanies, one } from '../db.js';
import { uid, nowIso, toE164BR, normalizeDomain, normalizeInstagram, instagramUrl, pMap, tipoTelefone } from '../util.js';
import { emit, log } from '../realtime.js';
import { searchPlaces } from './places.js';
import { enrichFromWebsite } from './scrape.js';
import { consultarCnpj } from './cnpj.js';
import { scoreCompany, dedupe } from './validate.js';
import { searchCompaniesViaWeb, findInstagramViaWeb, qualifyCompanies, traduzirErro, medindo } from '../ai/claude.js';

function pickSource() {
  const wanted = config.prospect.source;
  if (wanted === 'places') {
    if (!config.prospect.googleKey) throw new Error('PROSPECT_SOURCE=places exige GOOGLE_MAPS_API_KEY no .env.');
    return 'places';
  }
  if (wanted === 'claude') {
    if (!hasAI()) throw new Error('A busca por IA exige ANTHROPIC_API_KEY no .env.');
    return 'claude';
  }
  // auto: a IA e a fonte padrao; o Google Places entra so se nao houver IA.
  if (hasAI()) return 'claude';
  if (config.prospect.googleKey) return 'places';
  throw new Error('Nenhuma fonte de prospeccao configurada. Defina GOOGLE_MAPS_API_KEY ou ANTHROPIC_API_KEY.');
}

const dddDe = (e164) => (e164 ? e164.replace(/\D/g, '').slice(2, 4) : null);

/** Penaliza quem tem DDD diferente do DDD dominante da busca. */
function marcarDddForaDaRegiao(items, step) {
  const contagem = new Map();
  for (const c of items) {
    const ddd = dddDe(c.phoneE164);
    if (ddd) contagem.set(ddd, (contagem.get(ddd) ?? 0) + 1);
  }
  if (contagem.size < 2) return;

  const [dddRegiao, votos] = [...contagem.entries()].sort((a, b) => b[1] - a[1])[0];
  // So confia no "DDD da regiao" se ele for mesmo maioria.
  if (votos < 2 || votos / items.filter((c) => c.phoneE164).length < 0.5) return;

  let foraDaRegiao = 0;
  for (const c of items) {
    const ddd = dddDe(c.phoneE164);
    if (!ddd || ddd === dddRegiao) continue;
    foraDaRegiao++;
    c.score = Math.max(0, (c.score ?? 0) - 25);
    c.reasons = [...(c.reasons ?? []), `DDD ${ddd} fora da regiao (a maioria e ${dddRegiao})`];
    c.dddSuspeito = true;
    if (c.score < 45) c.passesTech = false;
  }
  if (foraDaRegiao) {
    step(`${foraDaRegiao} empresa(s) com DDD diferente de ${dddRegiao}: telefone suspeito, penalizadas.`);
  }
}

/**
 * Pipeline completo de prospeccao.
 * 1. busca bruta  2. normaliza + dedup  3. visita site (instagram/email)
 * 4. score tecnico  5. auditoria por IA  6. corta na quantidade pedida
 */
/**
 * Busca igual feita ha poucos dias? Reaproveita em vez de pagar de novo.
 * Empresa nao muda de telefone toda semana; repetir a mesma consulta seria
 * gastar de novo pelo mesmo resultado.
 */
function buscaReaproveitavel({ segment, region, quantity }) {
  const dias = config.prospect.reaproveitarDias;
  if (!dias) return null;
  const limite = new Date(Date.now() - dias * 86400000).toISOString();
  const anterior = one(
    `SELECT * FROM searches
     WHERE status='concluida' AND created_at > ?
       AND lower(trim(segment)) = lower(trim(?)) AND lower(trim(region)) = lower(trim(?))
     ORDER BY created_at DESC LIMIT 1`,
    limite,
    segment,
    region
  );
  if (!anterior) return null;
  const empresas = listCompanies(anterior.id);
  return empresas.length >= Math.min(quantity, anterior.quantity) ? { anterior, empresas } : null;
}

/** Roda a busca medindo quanto ela custou de API. */
export async function runSearch(params) {
  const searchId = params.searchId ?? uid('sch_');

  const reuso = buscaReaproveitavel({
    segment: params.segment,
    region: params.region,
    quantity: Math.min(Math.max(Number(params.quantity) || 10, 1), 100),
  });
  if (reuso) {
    const dias = Math.round((Date.now() - new Date(reuso.anterior.created_at)) / 86400000);
    const aviso =
      `Voce ja buscou "${params.segment}" em "${params.region}" ` +
      `${dias === 0 ? 'hoje' : `ha ${dias} dia(s)`}: reaproveitando ${reuso.empresas.length} empresas ` +
      `(custo zero). Para forcar uma busca nova, mude o texto ou zere REAPROVEITAR_BUSCA_DIAS no .env.`;
    log('prospeccao', aviso);
    emit('search:step', { searchId: reuso.anterior.id, message: aviso });
    emit('search:done', { searchId: reuso.anterior.id, companies: reuso.empresas, reaproveitada: true });
    return { searchId: reuso.anterior.id, companies: reuso.empresas, reaproveitada: true };
  }

  const { resultado, uso } = await medindo('busca', searchId, () => executarBusca({ ...params, searchId }));
  update('searches', searchId, { custo_usd: uso.usd, uso: JSON.stringify(uso) });
  log('custo', `Busca ${searchId}: US$ ${uso.usd.toFixed(4)} (${uso.entrada + uso.saida} tokens, ${uso.buscas} buscas na web)`);
  emit('search:custo', { searchId, ...uso });
  return { ...resultado, custo: uso };
}

async function executarBusca({ segment, region, quantity, searchId = uid('sch_') }) {
  const want = Math.min(Math.max(Number(quantity) || 10, 1), 100);

  // Falta de fonte configurada precisa virar evento no painel, e nao promessa
  // rejeitada em silencio: senao a tela fica presa em "Buscando...".
  let source;
  try {
    source = pickSource();
  } catch (err) {
    insert('searches', {
      id: searchId,
      segment,
      region,
      quantity: want,
      status: 'erro',
      source: null,
      log: err.message,
      created_at: nowIso(),
    });
    emit('search:error', { searchId, message: err.message });
    log('prospeccao', `ERRO: ${err.message}`);
    throw err;
  }

  insert('searches', {
    id: searchId,
    segment,
    region,
    quantity: want,
    status: 'buscando',
    source,
    log: null,
    created_at: nowIso(),
  });
  emit('search:start', { searchId, segment, region, quantity: want, source });

  const step = (msg) => {
    log('prospeccao', msg, { searchId });
    emit('search:step', { searchId, message: msg });
  };

  try {
    // ---- 1. busca bruta (com folga, porque a validacao derruba parte) ----
    // Na busca por IA cada empresa a mais custa minutos de pesquisa na web,
    // entao a folga aqui e enxuta; no Places, que e instantaneo, pode ser larga.
    const overshoot =
      source === 'places'
        ? Math.min(Math.ceil(want * 2.5), 60)
        : Math.min(Math.max(want + 3, Math.ceil(want * 1.6)), 40);
    step(`Buscando "${segment}" em "${region}" via ${source === 'places' ? 'Google Places' : 'IA + web search'}...`);

    const { resultado: raw } = await medindo('busca:web', searchId, () =>
      source === 'places'
        ? searchPlaces({ segment, region, want: overshoot })
        : searchCompaniesViaWeb({ segment, region, quantity: overshoot, minimo: want, onProgress: step })
    );

    step(`${raw.length} empresas encontradas na fonte. Normalizando e removendo duplicadas...`);

    // ---- 2. normalizacao + dedupe ----
    let items = raw
      .filter((c) => c.name)
      .map((c) => ({
        ...c,
        phoneE164: toE164BR(c.phone),
        domain: normalizeDomain(c.website),
        instagram: normalizeInstagram(c.instagram),
      }));
    items = dedupe(items);
    step(`${items.length} empresas unicas. Verificando sites e redes sociais...`);

    // ---- 3. enriquecimento pelo site ----
    await pMap(
      items,
      async (c) => {
        if (!c.website) return;
        const info = await enrichFromWebsite(c.website);
        c.siteOk = info.siteOk;
        c.siteStatus = info.siteStatus;
        c.instagram = c.instagram ?? info.instagram;
        c.email = c.email ?? info.email;
        c.whatsapp = info.whatsapp;
        // WhatsApp divulgado pela propria empresa: em negocio pequeno, quase
        // sempre o celular de quem decide.
        if (info.whatsapp && tipoTelefone(info.whatsapp) === 'celular') c.celularPublicado = info.whatsapp;
        if (!c.phoneE164) c.phoneE164 = info.phoneFromSite;
        if (!c.category && info.title) c.category = info.title.slice(0, 80);
        c.cnpj = c.cnpj ?? info.cnpj;
      },
      6
    );

    // ---- 3b. Receita Federal (de graca, sem gastar token de IA) ----
    // O CNPJ sai do rodape do site (ou do que a IA ja viu). A Receita devolve
    // o nome do socio, o telefone registrado e a situacao cadastral - dado que
    // busca nenhuma entrega e que separa empresa viva de empresa baixada.
    if (config.prospect.buscarCnpj) {
      const comCnpj = items.filter((c) => c.cnpj);
      if (comCnpj.length) {
        step(`Consultando a Receita Federal de ${comCnpj.length} empresa(s) (gratis)...`);
        let ativas = 0;
        let telefonesNovos = 0;
        let celulares = 0;
        await pMap(
          comCnpj,
          async (c) => {
            const receita = await consultarCnpj(c.cnpj);
            if (!receita) return;
            c.razaoSocial = receita.razaoSocial;
            c.situacao = receita.situacao;
            c.decisor = receita.decisor;
            c.socios = receita.socios;
            c.receitaAtiva = receita.ativa;
            if (receita.ativa) ativas++;

            // Telefone da Receita: alternativa - e principal, se nao havia nenhum.
            const tel = toE164BR(receita.telefoneReceita) ?? toE164BR(receita.telefoneReceita2);
            if (tel) {
              c.phoneReceita = tel;
              // Celular registrado no CNPJ de empresa pequena e, na pratica, o
              // telefone do dono: nao passa por recepcao. E o dado mais valioso
              // que da para tirar de registro publico - o pessoal nao existe la.
              if (tipoTelefone(tel) === 'celular' && (receita.porteMenor || receita.empresarioIndividual)) {
                c.celularResponsavel = tel;
                celulares++;
              }
              if (!c.phoneE164) {
                c.phoneE164 = tel;
                telefonesNovos++;
              }
            }
            if (!c.email && receita.emailReceita) c.email = receita.emailReceita;
          },
          2
        );
        step(
          `Receita: ${ativas} com CNPJ ativo` +
            (telefonesNovos ? `, ${telefonesNovos} telefone(s) recuperado(s)` : '') +
            `, ${comCnpj.filter((c) => c.decisor).length} com nome do socio` +
            (celulares ? `, ${celulares} com CELULAR do responsavel` : '') + '.'
        );
      }
    }

    // ---- 3d. fixo ou celular? ----
    // Celular nao passa por recepcao: fala com alguem que decide, ou pelo menos
    // com alguem que conhece o dono. Em negocio pequeno costuma ser o proprio.
    for (const c of items) {
      c.tipoTelefone = tipoTelefone(c.phoneE164);
      if (!c.celularResponsavel && c.tipoTelefone === 'celular') c.celularDireto = c.phoneE164;
    }

    // ---- 4. score tecnico ----
    for (const c of items) {
      const { score, reasons, passes } = scoreCompany(c);
      c.score = score;
      c.reasons = reasons;
      c.passesTech = passes;
    }
    // ---- 4b. o DDD bate com a regiao? ----
    // Empresas da mesma busca sao da mesma praca, entao o DDD dominante e o da
    // regiao. Quem foge dele quase sempre e telefone lido errado (numero de
    // outra unidade, digito colado num script) e ligar nele e ligacao perdida.
    marcarDddForaDaRegiao(items, step);

    let candidates = items.filter((c) => c.passesTech).sort((a, b) => b.score - a.score);
    step(`${candidates.length} empresas passaram na validacao tecnica (telefone + existencia).`);

    // ---- 5. auditoria por IA ----
    if (hasAI() && candidates.length) {
      const pool = candidates.slice(0, Math.min(candidates.length, want * 2));
      step(`IA auditando ${pool.length} empresas (real? do segmento?)...`);
      try {
        const { resultado: verdicts } = await medindo('busca:auditoria', searchId, () =>
          qualifyCompanies({ segment, region, companies: pool })
        );
        for (const v of verdicts) {
          const c = pool[v.i];
          if (!c) continue;
          c.verdict = v.real && v.do_segmento ? 'aprovada' : 'reprovada';
          c.notes = v.motivo ?? null;
          if (typeof v.score === 'number') c.score = Math.round((c.score + v.score) / 2);
          if (c.verdict === 'reprovada') c.reasons = [...(c.reasons ?? []), `IA: ${v.motivo ?? 'reprovada'}`];
        }
        const reprovadas = pool.filter((c) => c.verdict === 'reprovada').length;
        candidates = pool.filter((c) => c.verdict !== 'reprovada').sort((a, b) => b.score - a.score);
        step(`IA reprovou ${reprovadas}. Restaram ${candidates.length} empresas confiaveis.`);
      } catch (err) {
        step(`Auditoria por IA falhou: ${traduzirErro(err)}. Seguindo so com a validacao tecnica.`);
      }
    }

    // ---- 6. corte final ----
    const finalList = candidates.slice(0, want);

    // Instagram que faltou: so para quem VAI ser entregue. Cada consulta dessas
    // e uma busca na web, entao rodar na lista inteira antes do corte jogava
    // minutos fora com empresas que seriam descartadas.
    const semInsta = finalList.filter((c) => !c.instagram);
    if (hasAI() && semInsta.length && config.prospect.buscarInstagram) {
      step(`Procurando o Instagram de ${semInsta.length} empresas...`);
      await pMap(
        semInsta,
        async (c) => {
          const handle = await findInstagramViaWeb({ name: c.name, region, website: c.website });
          if (handle) c.instagram = normalizeInstagram(handle);
        },
        4
      );
    }

    // ---- 7. persistencia ----
    for (const c of finalList) {
      c.instagramUrl = instagramUrl(c.instagram);
      saveCompany(searchId, c);
    }

    update('searches', searchId, {
      status: 'concluida',
      log: JSON.stringify({
        encontradas: raw.length,
        unicas: items.length,
        aprovadas: candidates.length,
        entregues: finalList.length,
      }),
    });

    const saved = listCompanies(searchId);
    step(`Prospeccao concluida: ${saved.length} empresas prontas para ligar.`);
    emit('search:done', { searchId, companies: saved });
    return { searchId, companies: saved, source };
  } catch (err) {
    const motivo = traduzirErro(err);
    update('searches', searchId, { status: 'erro', log: motivo });
    emit('search:error', { searchId, message: motivo });
    log('prospeccao', `ERRO: ${motivo}`);
    throw err;
  }
}
