import Anthropic from '@anthropic-ai/sdk';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config, hasAI } from '../config.js';
import { extractJson } from '../util.js';
import { log } from '../realtime.js';

// ---------------------------------------------------------------------------
// Medidor de custo
// Precos oficiais (platform.claude.com/docs/en/about-claude/pricing):
//   Opus 5 .... US$ 5,00 / milhao de tokens de ENTRADA
//               US$ 25,00 / milhao de tokens de SAIDA
//               US$ 0,50 / milhao em leitura de cache
//   Busca web . US$ 10,00 / 1.000 buscas  (US$ 0,01 por busca)
// A execucao de codigo que a busca usa por baixo nao e cobrada.
// ---------------------------------------------------------------------------
export const PRECOS = {
  'claude-opus-5': { entrada: 5, saida: 25, cache: 0.5 },
  'claude-opus-4-8': { entrada: 5, saida: 25, cache: 0.5 },
  'claude-sonnet-5': { entrada: 2, saida: 10, cache: 0.2 },
  'claude-haiku-4-5': { entrada: 1, saida: 5, cache: 0.1 },
  padrao: { entrada: 5, saida: 25, cache: 0.5 },
  buscaWeb: 0.01,
};

const medidorALS = new AsyncLocalStorage();

export function custoDe({ entrada = 0, saida = 0, cache = 0, buscas = 0 }, modelo = config.anthropic.model) {
  const p = PRECOS[modelo] ?? PRECOS.padrao;
  return (
    (entrada / 1e6) * p.entrada +
    (saida / 1e6) * p.saida +
    (cache / 1e6) * p.cache +
    buscas * PRECOS.buscaWeb
  );
}

/**
 * Roda uma operacao medindo tudo que ela gastar na API.
 * Medidores aninhados somam no de fora tambem: assim a busca continua com o
 * total certo, e ainda da para ver quanto foi da auditoria, do instagram etc.
 */
export async function medindo(tipo, refId, fn) {
  const pai = medidorALS.getStore();
  const uso = { tipo, refId, entrada: 0, saida: 0, cache: 0, buscas: 0, chamadas: 0, usd: 0 };
  const resultado = await medidorALS.run(uso, fn);
  if (pai) {
    for (const campo of ['entrada', 'saida', 'cache', 'buscas', 'chamadas', 'usd']) pai[campo] += uso[campo];
  }
  return { resultado, uso };
}

let aoRegistrar = null;
/** O servidor pluga aqui a persistencia (evita a IA depender do banco). */
export const registrarUsoCom = (fn) => { aoRegistrar = fn; };

function contabilizar(usage, modelo = config.anthropic.model) {
  if (!usage) return;
  const registro = {
    entrada: usage.input_tokens ?? 0,
    saida: usage.output_tokens ?? 0,
    cache: usage.cache_read_input_tokens ?? 0,
    buscas: usage.server_tool_use?.web_search_requests ?? 0,
  };
  const atual = medidorALS.getStore();
  if (atual) {
    atual.entrada += registro.entrada;
    atual.saida += registro.saida;
    atual.cache += registro.cache;
    atual.buscas += registro.buscas;
    atual.chamadas += 1;
    atual.usd += custoDe(registro, modelo);
  }
  aoRegistrar?.({
    ...registro,
    tipo: atual?.tipo ?? 'avulso',
    refId: atual?.refId ?? null,
    modelo,
    usd: custoDe(registro, modelo),
  });
}

let _client = null;
function client() {
  if (!hasAI()) throw new Error('ANTHROPIC_API_KEY nao configurada');
  // maxRetries baixo de proposito: com busca na web cada tentativa custa
  // minutos, e 3 tentativas presas seriam meia hora de tela parada.
  if (!_client) _client = new Anthropic({ apiKey: config.anthropic.apiKey, maxRetries: 1 });
  return _client;
}

/**
 * Traduz o erro da API para algo acionavel no painel. Sem isso o usuario ve
 * "Rodada 1 falhou (400 ...)" e nao descobre que so precisa comprar credito.
 */
export function traduzirErro(err) {
  const msg = String(err?.message ?? err);
  if (/credit balance is too low/i.test(msg))
    return 'Sua conta da Anthropic esta sem creditos. Entre em console.anthropic.com > Plans & Billing e adicione creditos.';
  if (/invalid x-api-key|authentication_error/i.test(msg))
    return 'A ANTHROPIC_API_KEY do .env e invalida ou foi revogada. Gere outra em console.anthropic.com.';
  if (/rate_limit/i.test(msg))
    return 'Limite de uso da API atingido. Espere alguns minutos e tente de novo.';
  if (/terminated|timeout|aborted/i.test(msg)) return 'a IA demorou demais e a rodada foi interrompida';
  if (/overloaded/i.test(msg)) return 'A API da Anthropic esta sobrecarregada agora. Tente de novo em instantes.';
  return msg;
}

/** Erro que nao adianta insistir: precisa de acao do dono da conta. */
export const erroFatal = (err) =>
  /credit balance is too low|invalid x-api-key|authentication_error|permission_error/i.test(
    String(err?.message ?? err)
  );

const textOf = (msg) =>
  (msg?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

/**
 * Chamada base. Tenta o caminho beta com fallback server-side (recomendado no
 * Opus 5: se um classificador recusar, a Anthropic reroteia em vez de derrubar o
 * fluxo em producao) e cai para o endpoint padrao se o beta nao estiver liberado.
 */
async function chat({
  system,
  messages,
  maxTokens = 2000,
  effort = 'high',
  tools,
  stream = false,
  onSearch,
  timeoutMs,
  model = config.anthropic.model,
}) {
  const base = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
    output_config: { effort },
    ...(tools ? { tools } : {}),
  };
  // O fallback server-side so existe na familia Opus/Fable. Mandar para o
  // Sonnet gera um 400 e queima uma requisicao inteira antes do retry.
  const aceitaFallback = /^claude-(opus-5|opus-4-8|fable-5|mythos-5)$/.test(model);
  const beta = aceitaFallback
    ? { ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
    : base;
  const opts = timeoutMs ? { timeout: timeoutMs } : undefined; // milissegundos no SDK TS
  const semBeta = (err) => err?.status === 400 || err?.status === 404;

  // Requisicoes longas (busca na web, respostas grandes) vao em streaming: sem
  // isso a conexao fica pendurada ate estourar o timeout de 10 minutos do SDK.
  if (stream) {
    // Vigia de inatividade. O timeout do SDK nao interrompeu buscas que
    // pararam de responder no meio: a pesquisa ficava presa para sempre e o
    // painel congelado em "Rodada 1". Aqui, se o modelo passa muito tempo sem
    // emitir nada, a chamada e abortada e a rodada segue com o que ja tem.
    const INATIVIDADE = 90000;
    const executar = async (params) => {
      const s = client().beta.messages.stream(params, opts);
      const inicio = Date.now();
      let ultimoEvento = Date.now();
      const relogio = setInterval(() => {
        if (s.aborted) return;
        // Dois freios: silencio prolongado e teto absoluto. O teto e o que
        // importa de verdade - o modelo pode ficar girando em busca atras de
        // busca, emitindo eventos o tempo todo, sem nunca fechar a resposta.
        const parado = Date.now() - ultimoEvento > INATIVIDADE;
        const estourou = timeoutMs && Date.now() - inicio > timeoutMs;
        if (parado || estourou) {
          log(
            'ia',
            parado
              ? `sem resposta ha ${Math.round(INATIVIDADE / 1000)}s: abortando`
              : `passou de ${Math.round(timeoutMs / 1000)}s: abortando e seguindo com o que ja veio`
          );
          s.abort();
        }
      }, 5000);
      relogio.unref?.();

      s.on('streamEvent', () => { ultimoEvento = Date.now(); });
      if (onSearch) {
        s.on('contentBlock', (block) => {
          if (block.type === 'server_tool_use' && block.name === 'web_search') {
            onSearch(block.input?.query ?? null);
          }
        });
      }
      try {
        return await s.finalMessage();
      } finally {
        clearInterval(relogio);
      }
    };

    let msg;
    try {
      msg = await executar(beta);
    } catch (err) {
      if (!semBeta(err)) throw err;
      msg = await executar(base);
    }
    contabilizar(msg.usage, model);
    return msg;
  }

  let msg;
  try {
    msg = await client().beta.messages.create(beta, opts);
  } catch (err) {
    if (!semBeta(err)) throw err;
    msg = await client().messages.create(base, opts);
  }
  contabilizar(msg.usage, model);
  return msg;
}

async function askJson({ system, prompt, maxTokens = 4000, effort = 'high', timeoutMs = 120000, model }) {
  const msg = await chat({
    system,
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
    effort,
    timeoutMs,
    model,
  });
  const parsed = extractJson(textOf(msg));
  if (!parsed) throw new Error('IA nao retornou JSON valido');
  return parsed;
}

// ---------------------------------------------------------------------------
// 1) Busca de empresas SO com IA (Claude + web search) - nao precisa do Google
// ---------------------------------------------------------------------------
const SEARCH_SYSTEM =
  'Voce e um pesquisador de prospeccao B2B no Brasil.\n\n' +
  'ORCAMENTO DE PESQUISA (obrigatorio): no maximo 4 buscas nesta rodada. Use buscas de ' +
  'LISTAGEM ("clinicas de estetica em Uberlandia telefone"), que trazem varias empresas de ' +
  'uma vez. NAO pesquise empresa por empresa para completar dados - isso gasta a rodada inteira ' +
  'com duas ou tres empresas.\n\n' +
  'QUANDO PARAR: assim que tiver a quantidade pedida, pare de pesquisar e responda o JSON. ' +
  'Faltou o Instagram ou o site de alguma? Responda null nesse campo. NAO faca buscas extras ' +
  'para preencher lacunas - outra etapa do sistema completa isso depois.\n\n' +
  'REGRA DE OURO: nunca invente telefone, site ou @ do Instagram. So preencha o que voce leu na ' +
  'fonte; um telefone errado vira uma ligacao perdida. O telefone com DDD e o campo mais ' +
  'importante - prefira empresas cujo telefone apareceu no resultado da busca.\n\n' +
  'Sua resposta final DEVE ser o JSON pedido, sempre. Nunca termine sem ele.';

const NORMALIZE = (c) => ({
  name: c.name,
  phone: c.phone ?? null,
  website: c.website ?? null,
  instagram: c.instagram ?? null,
  address: c.address ?? null,
  category: c.category ?? null,
  cnpj: c.cnpj ?? null,
  notes: c.evidence ?? null,
  source: 'claude-web-search',
});

/**
 * Busca em rodadas: cada rodada pede um lote novo, informando quem ja foi
 * encontrado. Uma unica chamada tende a devolver poucas empresas e repetir as
 * mais famosas; em lotes o modelo varre bairros e fontes diferentes.
 */
export async function searchCompaniesViaWeb({ segment, region, quantity, minimo = 0, onProgress }) {
  const encontradas = new Map();
  const lote = 5;
  const maxRodadas = Math.min(Math.ceil(quantity / lote) + 2, 6);
  const inicio = Date.now();

  for (let rodada = 1; rodada <= maxRodadas; rodada++) {
    if (encontradas.size >= quantity) break;
    // Cada rodada custa ~3 minutos de pesquisa. Se ja da para entregar o que o
    // usuario pediu, nao vale prender ele na tela so para ter folga extra.
    if (encontradas.size >= minimo && Date.now() - inicio > 150000) {
      onProgress?.(`Ja temos ${encontradas.size} empresas: encerrando a pesquisa para nao demorar mais.`);
      break;
    }
    const faltam = quantity - encontradas.size;
    const jaTem = [...encontradas.keys()];

    onProgress?.(
      `Rodada ${rodada}: a IA esta procurando mais ${Math.min(faltam, lote)} empresas` +
        (jaTem.length ? ` (ja tem ${jaTem.length})` : '') + '...'
    );

    let msg;
    let buscas = 0;
    const t0 = Date.now();
    try {
      msg = await chat({
        stream: true,
        timeoutMs: 150000,
        onSearch: (q) => {
          buscas++;
          onProgress?.(`Pesquisando na web (${buscas}): ${q ?? 'consulta'}`);
        },
        system: SEARCH_SYSTEM,
        messages: [
          {
            role: 'user',
            content:
              `Encontre ${Math.min(faltam, lote)} empresas do segmento "${segment}" na regiao "${region}".\n\n` +
              (jaTem.length
                ? `JA ENCONTRADAS (nao repita nenhuma delas):\n${jaTem.join(', ')}\n\n` +
                  'Procure em bairros, cidades vizinhas e fontes DIFERENTES das que voce ja usou.\n\n'
                : '') +
              'Para cada empresa colete: nome, telefone comercial com DDD, site, instagram (@), endereco e categoria.\n' +
              'Descarte: agregadores, marketplaces, diretorios, franquias sem telefone local e empresas fechadas.\n\n' +
              'Responda SOMENTE com JSON:\n' +
              '{"empresas":[{"name":"","phone":"","website":"","instagram":"","address":"","category":"","cnpj":"","evidence":"url da fonte"}]}',
          },
        ],
        maxTokens: 6000,
        effort: 'low',
        model: config.anthropic.modelBusca,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
      });
    } catch (err) {
      const motivo = traduzirErro(err);
      // Sem credito ou com chave invalida nao adianta continuar: se nada foi
      // encontrado ainda, a busca precisa FALHAR com o motivo na tela, senao o
      // painel diz "0 empresas" e o usuario procura problema no lugar errado.
      if (erroFatal(err) && encontradas.size === 0) throw new Error(motivo);
      onProgress?.(`Rodada ${rodada} interrompida: ${motivo}. Seguindo com o que ja foi encontrado.`);
      break;
    }
    onProgress?.(`Rodada ${rodada}: ${buscas} buscas na web em ${Math.round((Date.now() - t0) / 1000)}s.`);

    const texto = textOf(msg);
    const data = extractJson(texto);
    const lista = data?.empresas ?? data?.companies ?? [];

    // Rodada cara que volta vazia precisa deixar rastro: sem isso o usuario ve
    // "0 empresas" e nao tem como saber se o modelo nao achou, nao respondeu em
    // JSON, ou foi cortado no meio.
    if (!lista.length) {
      log(
        'ia',
        `Rodada ${rodada} sem empresas | stop=${msg.stop_reason} | json=${data ? 'ok' : 'nao encontrado'} | ` +
          `texto: ${texto.slice(0, 200).replace(/\s+/g, ' ')} [...] ${texto.slice(-200).replace(/\s+/g, ' ')}`
      );
    }
    let novas = 0;
    for (const c of lista) {
      if (!c?.name) continue;
      const chave = String(c.name).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!chave || encontradas.has(c.name) || [...encontradas.keys()].some((k) => k.toLowerCase().replace(/[^a-z0-9]/g, '') === chave)) continue;
      encontradas.set(c.name, NORMALIZE(c));
      novas++;
    }
    onProgress?.(`Rodada ${rodada}: +${novas} empresas novas (total ${encontradas.size}).`);
    if (!novas) break; // a fonte se esgotou; insistir so gastaria tokens
  }

  return [...encontradas.values()];
}

/** Procura o Instagram oficial de uma empresa quando o site nao revela. */
export async function findInstagramViaWeb({ name, region, website }) {
  try {
    const msg = await chat({
      system: 'Responda apenas com JSON. Nao invente perfis: se nao achar com certeza, use null.',
      messages: [
        {
          role: 'user',
          content:
            `Qual o perfil oficial no Instagram da empresa "${name}"${region ? ' em ' + region : ''}` +
            `${website ? ' (site: ' + website + ')' : ''}?\n` +
            'Responda: {"instagram":"@handle ou null","confianca":0.0}',
        },
      ],
      maxTokens: 1500,
      effort: 'low',
      timeoutMs: 90000,
      model: config.anthropic.modelBusca,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    });
    const data = extractJson(textOf(msg));
    if (data?.instagram && (data.confianca ?? 1) >= 0.6) return data.instagram;
    return null;
  } catch (err) {
    log('ia', `falha ao buscar instagram de ${name}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2) Qualificacao: a empresa e real e faz sentido para o nicho?
// ---------------------------------------------------------------------------
export async function qualifyCompanies({ segment, region, companies }) {
  if (!companies.length) return [];
  const payload = companies.map((c, i) => ({
    i,
    nome: c.name,
    telefone: c.phoneE164 ?? c.phone,
    site: c.website,
    instagram: c.instagram,
    endereco: c.address,
    avaliacoes: c.reviews,
    nota: c.rating,
    categoria: c.category,
    sinais_tecnicos: c.reasons,
  }));
  const data = await askJson({
    system:
      'Voce audita listas de prospeccao. Avalie se cada registro e uma EMPRESA REAL e ATIVA ' +
      'e se pertence mesmo ao segmento pedido. Rejeite: agregadores/diretorios, paginas de ' +
      'listagem, empresas fechadas, dados inconsistentes e registros de outro segmento.\n' +
      'CONFIRA O TELEFONE: o DDD tem que ser o da regiao pedida (ex: Uberlandia = 34, ' +
      'Sao Paulo capital = 11). DDD de outra praca quase sempre significa numero lido errado — ' +
      'nesse caso reprove (real=false) e diga isso no motivo, porque ligar nele e ligacao perdida.',
    prompt:
      `Segmento alvo: "${segment}". Regiao alvo: "${region}".\n\n` +
      `Registros:\n${JSON.stringify(payload, null, 1)}\n\n` +
      'Responda SOMENTE JSON: {"resultados":[{"i":0,"real":true,"do_segmento":true,' +
      '"score":0,"motivo":"curto"}]} com score de 0 a 100.',
    maxTokens: 8000,
    effort: 'medium',
    model: config.anthropic.modelAuditoria,
  });
  return data?.resultados ?? [];
}

// ---------------------------------------------------------------------------
// 3) Script da ligacao e conducao da conversa
// ---------------------------------------------------------------------------
export function fallbackOpening(company) {
  const { sdrName, companyName } = config.business;
  return `Ola! Aqui e ${sdrName}, da ${companyName}. Falo com alguem responsavel da ${company?.name ?? 'empresa'}? Tenho uma proposta rapida, posso falar trinta segundos?`;
}

export async function generateOpening({ company, segment }) {
  if (!hasAI()) return fallbackOpening(company);
  try {
    const msg = await chat({
      system: 'Voce escreve aberturas de cold call em portugues do Brasil. Natural, curta, sem jargao.',
      messages: [
        {
          role: 'user',
          content:
            `Empresa alvo: ${company?.name} (${segment ?? company?.category ?? ''}).\n` +
            `Quem liga: ${config.business.sdrName}, SDR da ${config.business.companyName}.\n` +
            `Oferta: ${config.business.pitch}\n\n` +
            'Escreva a primeira fala da ligacao: no maximo 2 frases, pede para falar com o responsavel ' +
            'e pede permissao para 30 segundos. Responda so com a fala.',
        },
      ],
      maxTokens: 400,
      effort: 'low',
      model: config.anthropic.modelConversa,
    });
    return textOf(msg) || fallbackOpening(company);
  } catch {
    return fallbackOpening(company);
  }
}

const SDR_SYSTEM = () =>
  `Voce e ${config.business.sdrName}, SDR por telefone da ${config.business.companyName}, falando ` +
  `portugues do Brasil ao telefone. Oferta: ${config.business.pitch}\n` +
  'REGRAS:\n' +
  '- Fale como gente: frases curtas, no maximo 2 por resposta. Sem emoji, sem markdown, sem listas.\n' +
  '- Seu unico objetivo e qualificar rapido (a pessoa e decisora? tem a dor? tem interesse?) e ' +
  'segurar a conversa ate o especialista humano entrar na linha.\n' +
  '- Se a pessoa disser que nao tem interesse ou pedir para nao ligar mais, agradeca e encerre.\n' +
  '- Se pedirem material ou preco, ofereca mandar no WhatsApp.\n' +
  '- Voce e uma assistente virtual: se perguntarem se e um robo ou uma IA, admita na hora.';

/**
 * Um turno da conversa por telefone.
 * Retorna { reply, action } com action = continuar | transferir | encerrar | whatsapp
 */
export async function sdrTurn({ company, transcript, speech }) {
  if (!hasAI()) {
    return {
      reply: 'Entendi. Vou passar voce para um especialista, um instante por favor.',
      action: 'transferir',
    };
  }
  const history = transcript
    .map((t) => `${t.role === 'assistant' ? 'IA' : 'PESSOA'}: ${t.text}`)
    .join('\n');
  const data = await askJson({
    system: SDR_SYSTEM(),
    prompt:
      `Empresa: ${company?.name ?? '-'} | Segmento: ${company?.category ?? '-'}\n` +
      `Transcricao ate agora:\n${history || '(inicio)'}\n\n` +
      `A pessoa acabou de dizer: "${speech}"\n\n` +
      'Responda SOMENTE JSON: {"reply":"sua fala curta","action":"continuar|transferir|encerrar|whatsapp",' +
      '"interesse":"alto|medio|baixo","resumo":"1 linha para o vendedor humano"}\n' +
      'Use action=transferir assim que houver qualquer sinal de interesse ou pedido de detalhes.',
    maxTokens: 1200,
    effort: 'low',
    model: config.anthropic.modelConversa,
  });
  return {
    reply: data.reply || 'Entendi.',
    action: data.action || 'continuar',
    interesse: data.interesse ?? null,
    resumo: data.resumo ?? null,
  };
}

/** Briefing de 1 frase que o humano ouve antes de entrar na ligacao. */
export async function agentBriefing({ company, transcript }) {
  const base = `Empresa ${company?.name ?? 'desconhecida'} atendeu a ligacao.`;
  if (!hasAI() || !transcript?.length) return base;
  try {
    const msg = await chat({
      system: 'Resuma para um vendedor que vai assumir a ligacao AGORA. Uma frase, falada, sem enrolacao.',
      messages: [
        {
          role: 'user',
          content: `Empresa: ${company?.name}\nConversa:\n${transcript
            .map((t) => `${t.role}: ${t.text}`)
            .join('\n')}`,
        },
      ],
      maxTokens: 300,
      effort: 'low',
      model: config.anthropic.modelConversa,
    });
    return textOf(msg) || base;
  } catch {
    return base;
  }
}

// ---------------------------------------------------------------------------
// 4) WhatsApp
// ---------------------------------------------------------------------------
export async function whatsappFirstMessage({ company, contexto }) {
  const fallback =
    `Ola! Aqui e ${config.business.sdrName}, da ${config.business.companyName}. ` +
    `Tentei falar com voces por telefone. ${config.business.pitch} Posso te explicar em 2 minutos?`;
  if (!hasAI()) return fallback;
  try {
    const msg = await chat({
      system: 'Escreve mensagens curtas de primeiro contato no WhatsApp, em pt-BR. Sem spam, sem exagero de emoji.',
      messages: [
        {
          role: 'user',
          content:
            `Empresa: ${company?.name} (${company?.category ?? ''}).\n` +
            `Quem escreve: ${config.business.sdrName} da ${config.business.companyName}.\n` +
            `Oferta: ${config.business.pitch}\n` +
            `Contexto: ${contexto ?? 'ligamos e nao conseguimos falar'}\n\n` +
            'Escreva a mensagem (max 3 linhas, termina com uma pergunta). So a mensagem.',
        },
      ],
      maxTokens: 400,
      effort: 'low',
      model: config.anthropic.modelConversa,
    });
    return textOf(msg) || fallback;
  } catch {
    return fallback;
  }
}

export async function whatsappReply({ company, history, incoming }) {
  if (!hasAI()) return null;
  const msg = await chat({
    system:
      `Voce e ${config.business.sdrName}, SDR da ${config.business.companyName} atendendo no WhatsApp em pt-BR. ` +
      `Oferta: ${config.business.pitch}\n` +
      'Respostas curtas (max 3 linhas). Objetivo: agendar uma conversa com o especialista humano. ' +
      'Se pedirem para parar, agradeca e encerre. Se perguntarem se e um robo, admita.',
    messages: [
      ...history.map((m) => ({
        role: m.direction === 'in' ? 'user' : 'assistant',
        content: m.body,
      })),
      { role: 'user', content: incoming },
    ],
    maxTokens: 600,
    effort: 'low',
    model: config.anthropic.modelConversa,
  });
  return textOf(msg);
}
