import 'dotenv/config';

const bool = (v, def = false) => {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(v).toLowerCase());
};
const num = (v, def) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? def : Number(v));

export const config = {
  port: num(process.env.PORT, 3000),
  // Cadastro publico fechado por padrao. A primeira conta (o admin) sempre
  // pode ser criada; depois disso so o admin cria usuarios - senao qualquer
  // um que ache a URL abre conta e gasta o credito de API do dono.
  cadastroAberto: bool(process.env.CADASTRO_ABERTO, false),
  // Teto de gasto de quem se cadastra sozinho (vazio = sem teto).
  limitePadraoUsd: process.env.LIMITE_PADRAO_USD ? Number(process.env.LIMITE_PADRAO_USD) : null,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    // Cada tarefa pode usar um modelo diferente. Achar empresas de verdade na
    // web exige o modelo forte; conduzir a conversa e responder no WhatsApp
    // nao exige, e o modelo leve ainda responde mais rapido ao telefone.
    modelBusca: process.env.MODELO_BUSCA || process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    modelAuditoria: process.env.MODELO_AUDITORIA || 'claude-sonnet-5',
    modelConversa: process.env.MODELO_CONVERSA || 'claude-haiku-4-5',
  },

  prospect: {
    googleKey: process.env.GOOGLE_MAPS_API_KEY || '',
    source: process.env.PROSPECT_SOURCE || 'auto', // auto | places | claude
    // Repetir a mesma busca em poucos dias so gastaria de novo pelo mesmo
    // resultado: dentro desse prazo o sistema reaproveita o que ja tem.
    reaproveitarDias: num(process.env.REAPROVEITAR_BUSCA_DIAS, 7),
    buscarInstagram: bool(process.env.BUSCAR_INSTAGRAM, true),
    // Consulta a Receita Federal (BrasilAPI e afins): de graca, sem tokens.
    buscarCnpj: bool(process.env.BUSCAR_CNPJ, true),
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_PHONE_NUMBER || '',
    validateSignature: bool(process.env.TWILIO_VALIDATE_SIGNATURE, false),
    // Service SID do Twilio Conversational Intelligence (console.twilio.com >
    // Voice > Intelligence > Create Service). Sem isso a ligacao ainda e
    // gravada, mas nao ha transcricao/resumo automatico - so o audio.
    intelligenceSid: process.env.TWILIO_INTELLIGENCE_SID || '',
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM || '',
  },

  voice: {
    // direto = o vendedor entra na linha ANTES, o sistema disca para as empresas
    //          e quem atende cai direto na ligacao dele. Sem IA falando, sem tecla.
    // ia     = a IA SDR atende primeiro, qualifica e depois passa para o vendedor.
    modo: (process.env.MODO_LIGACAO || 'direto').toLowerCase(),
    // Quanto tempo esperar o vendedor atender antes de cancelar a campanha.
    esperaVendedor: num(process.env.ESPERA_VENDEDOR, 40),
    humanAgentPhone: process.env.HUMAN_AGENT_PHONE || '',
    handoffTimeout: num(process.env.HUMAN_HANDOFF_TIMEOUT, 45),
    ringTimeout: num(process.env.CALL_RING_TIMEOUT, 25),
    ttsVoice: process.env.TTS_VOICE || 'Polly.Camila-Neural',
    // Cada turno de fala custa reconhecimento de voz na Twilio. Depois desse
    // limite a IA para de qualificar e passa para o humano (ou encerra).
    maxTurnos: num(process.env.MAX_TURNOS_IA, 4),
    courtesyHangup:
      process.env.COURTESY_HANGUP_MESSAGE || 'Desculpe, foi engano. Tenha um otimo dia!',
    // Grava a ligacao vencedora (vendedor + empresa) para permitir a
    // transcricao e o resumo automatico. So o audio; a transcricao depende
    // de TWILIO_INTELLIGENCE_SID tambem estar configurado.
    gravarLigacoes: bool(process.env.GRAVAR_LIGACOES, true),
  },

  whatsapp: {
    provider: (process.env.WHATSAPP_PROVIDER || 'none').toLowerCase(),
    // Desligado de proposito: a IA so manda a primeira mensagem para quem nao
    // atendeu. A conversa a partir dai e do humano, no painel ou no celular.
    aiAutoReply: bool(process.env.WHATSAPP_AI_AUTOREPLY, false),

    // --- protecao do numero contra bloqueio ---
    // Rajada de mensagens para desconhecidos e o padrao classico de spam.
    // Estes limites transformam o disparo em gotejamento.
    intervaloMin: num(process.env.WHATSAPP_INTERVALO_MIN, 60), // segundos
    intervaloMax: num(process.env.WHATSAPP_INTERVALO_MAX, 180),
    limiteDiario: num(process.env.WHATSAPP_LIMITE_DIARIO, 40),
    limitePorHora: num(process.env.WHATSAPP_LIMITE_HORA, 12),
    horaInicio: num(process.env.WHATSAPP_HORA_INICIO, 9),
    horaFim: num(process.env.WHATSAPP_HORA_FIM, 19),
    descansoDias: num(process.env.WHATSAPP_DESCANSO_DIAS, 30),
    meta: {
      token: process.env.META_WA_TOKEN || '',
      phoneId: process.env.META_WA_PHONE_ID || '',
      verifyToken: process.env.META_WA_VERIFY_TOKEN || 'ia-sdr-verify',
    },
    evolution: {
      baseUrl: (process.env.EVOLUTION_BASE_URL || '').replace(/\/+$/, ''),
      apiKey: process.env.EVOLUTION_API_KEY || '',
      instance: process.env.EVOLUTION_INSTANCE || '',
    },
  },

  business: {
    companyName: process.env.COMPANY_NAME || 'Minha Empresa',
    pitch: process.env.COMPANY_PITCH || '',
    sdrName: process.env.SDR_AGENT_NAME || 'Alice',
  },

  mercadopago: {
    accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN || '',
    // Publica de verdade: vai para o navegador (tokenizacao do cartao). Nunca
    // confundir com o accessToken acima, que e secreto.
    publicKey: process.env.MERCADOPAGO_PUBLIC_KEY || '',
    // Secret usado para validar a assinatura (x-signature) dos webhooks -
    // Console do Mercado Pago > Sua integracao > Webhooks > Chave secreta.
    webhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET || '',
  },

  // Planos fixos (2 por enquanto). Preco em centavos de R$ para nao lidar com
  // ponto flutuante no dinheiro. "buscasMes"/"ligacoesMes" contam por CICLO da
  // assinatura (reinicia sozinho a cada renovacao, sem precisar de cron - ver
  // server/pagamentos/planos.js).
  planos: {
    basic: { id: 'basic', nome: 'Basic', precoCentavos: 14700, buscasMes: 15, ligacoesMes: 200 },
    pro: { id: 'pro', nome: 'Pro', precoCentavos: 39700, buscasMes: 50, ligacoesMes: 500 },
  },
  // Pacotes avulsos de credito extra (compra unica, nao expira, some do saldo
  // conforme e usado). Somam-se a cota do plano quando ela acaba no ciclo.
  creditos: {
    buscas: { id: 'buscas', rotulo: '+15 buscas', quantidade: 15, precoCentavos: 5700 },
    ligacoes: { id: 'ligacoes', rotulo: '+200 ligações', quantidade: 200, precoCentavos: 8700 },
  },
};

/** Telefonia real so liga se tiver credencial + URL publica. Senao, simulador. */
export const voiceMode = () =>
  config.twilio.accountSid && config.twilio.authToken && config.twilio.from && config.publicBaseUrl
    ? 'twilio'
    : 'simulation';

export const hasAI = () => Boolean(config.anthropic.apiKey);

// O telefone do vendedor pode ser salvo pelo painel; o .env vira apenas o
// padrao. Quem injeta o valor salvo e o servidor, para o config nao precisar
// conhecer o banco.
let vendedorSalvo = null;
export const definirVendedorSalvo = (tel) => {
  vendedorSalvo = tel || null;
};
export const telefoneDoVendedor = () => vendedorSalvo || config.voice.humanAgentPhone || null;

const curto = (m) => String(m).replace('claude-', '');

/** Qual fonte a prospeccao vai usar de fato com o .env atual. */
export function prospectSourceStatus() {
  const wanted = config.prospect.source;
  if (wanted === 'places' || (wanted === 'auto' && !hasAI() && config.prospect.googleKey)) {
    return config.prospect.googleKey
      ? { ok: true, detail: 'Google Places API' }
      : { ok: false, detail: 'PROSPECT_SOURCE=places sem GOOGLE_MAPS_API_KEY' };
  }
  if (hasAI()) return { ok: true, detail: 'IA (Claude + busca na web)' };
  return { ok: false, detail: 'Configure ANTHROPIC_API_KEY (ou GOOGLE_MAPS_API_KEY)' };
}

export function integrationStatus() {
  return {
    ia: hasAI()
      ? {
          ok: true,
          // Mostra o modelo de cada tarefa: um nome so escondia que a busca e a
          // conversa rodam em modelos (e precos) diferentes.
          detail: `busca ${curto(config.anthropic.modelBusca)} · conversa ${curto(config.anthropic.modelConversa)}`,
        }
      : { ok: false, detail: 'ANTHROPIC_API_KEY ausente' },
    prospeccao: prospectSourceStatus(),
    telefonia:
      voiceMode() === 'twilio'
        ? { ok: true, detail: `Twilio ${config.twilio.from}` }
        : { ok: false, detail: 'Modo simulacao (configure Twilio + PUBLIC_BASE_URL)' },
    humano: telefoneDoVendedor()
      ? { ok: true, detail: telefoneDoVendedor() }
      : { ok: false, detail: 'defina no painel ou em HUMAN_AGENT_PHONE' },
    whatsapp:
      config.whatsapp.provider !== 'none'
        ? { ok: true, detail: config.whatsapp.provider }
        : { ok: false, detail: 'Desativado (WHATSAPP_PROVIDER=none)' },
  };
}
