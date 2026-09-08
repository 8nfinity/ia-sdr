/**
 * Check-up do sistema: diz o que ja esta pronto e o que falta para as
 * ligacoes saírem de verdade. Testa as chaves batendo na API, nao so
 * conferindo se o campo esta preenchido.
 *
 * Uso: npm run checar
 */
import 'dotenv/config';
import { toE164BR, isPlausiblePhone } from '../server/util.js';

const V = '\x1b[32m';   // verde
const A = '\x1b[33m';   // amarelo
const R = '\x1b[31m';   // vermelho
const C = '\x1b[36m';   // ciano
const X = '\x1b[0m';

const itens = [];
const ok = (nome, detalhe) => itens.push({ estado: 'ok', nome, detalhe });
const falta = (nome, detalhe, comoResolver) => itens.push({ estado: 'falta', nome, detalhe, comoResolver });
const aviso = (nome, detalhe, comoResolver) => itens.push({ estado: 'aviso', nome, detalhe, comoResolver });

const env = (k) => (process.env[k] || '').trim();

console.log(`\n  ${C}Check-up do IA SDR${X}\n  ${'-'.repeat(60)}`);

// ---------------------------------------------------------------- 1. Node
const [maior, menor] = process.versions.node.split('.').map(Number);
if (maior > 22 || (maior === 22 && menor >= 5)) ok('Node', `versao ${process.versions.node}`);
else falta('Node', `versao ${process.versions.node} e antiga`, 'Instale o Node LTS em nodejs.org');

// ---------------------------------------------------------------- 2. IA
if (!env('ANTHROPIC_API_KEY')) {
  falta('IA (Anthropic)', 'ANTHROPIC_API_KEY vazia', 'Pegue em console.anthropic.com e cole no .env');
} else {
  process.stdout.write('  testando a chave da Anthropic...');
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const c = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY'), maxRetries: 0 });
    await c.messages.create({
      model: env('MODELO_CONVERSA') || 'claude-haiku-4-5',
      max_tokens: 5,
      messages: [{ role: 'user', content: 'ok' }],
    });
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
    ok('IA (Anthropic)', 'chave valida e com credito');
  } catch (err) {
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
    const m = String(err?.message ?? err);
    if (/credit balance is too low/i.test(m))
      falta('IA (Anthropic)', 'chave valida, mas SEM CREDITO', 'console.anthropic.com > Plans & Billing > adicione credito');
    else if (/authentication|invalid x-api-key/i.test(m))
      falta('IA (Anthropic)', 'chave invalida ou revogada', 'Gere outra em console.anthropic.com');
    else aviso('IA (Anthropic)', `nao consegui testar: ${m.slice(0, 60)}`, 'Verifique sua conexao');
  }
}

// ---------------------------------------------------------------- 3. Telefonia
const sid = env('TWILIO_ACCOUNT_SID');
const token = env('TWILIO_AUTH_TOKEN');
const numero = env('TWILIO_PHONE_NUMBER');

if (!sid || !token) {
  falta(
    'Telefonia (Twilio)',
    'sem credenciais - o sistema fica em modo simulacao',
    'Crie a conta em twilio.com, compre um numero e copie SID/TOKEN para o .env'
  );
} else {
  process.stdout.write('  testando a conta Twilio...');
  try {
    const { default: twilio } = await import('twilio');
    const client = twilio(sid, token);
    const conta = await client.api.v2010.accounts(sid).fetch();
    const numeros = await client.incomingPhoneNumbers.list({ limit: 20 });
    process.stdout.write('\r' + ' '.repeat(40) + '\r');

    if (conta.status !== 'active') {
      falta('Telefonia (Twilio)', `conta com status "${conta.status}"`, 'Verifique a conta no painel da Twilio');
    } else if (!numero) {
      falta('Telefonia (Twilio)', 'TWILIO_PHONE_NUMBER vazio', `Numeros na sua conta: ${numeros.map((n) => n.phoneNumber).join(', ') || 'nenhum - compre um'}`);
    } else if (!numeros.some((n) => n.phoneNumber === numero)) {
      falta('Telefonia (Twilio)', `o numero ${numero} nao esta nesta conta`, `Numeros disponiveis: ${numeros.map((n) => n.phoneNumber).join(', ') || 'nenhum'}`);
    } else {
      ok('Telefonia (Twilio)', `conta ativa, numero ${numero}`);

      // O passo mais esquecido: sem permissao geografica, a ligacao para o
      // Brasil e recusada pela Twilio sem explicacao no painel.
      try {
        const br = await client.voice.v1.dialingPermissions.countries('BR').fetch();
        if (br.lowRiskNumbersEnabled) ok('Ligar para o Brasil', 'permissao liberada');
        else
          falta(
            'Ligar para o Brasil',
            'BLOQUEADO nas permissoes geograficas',
            'Console Twilio > Voice > Settings > Geo Permissions > marque Brazil e salve'
          );
      } catch {
        aviso('Ligar para o Brasil', 'nao consegui checar a permissao', 'Confira em Voice > Settings > Geo Permissions');
      }

      if (conta.type === 'Trial') {
        aviso(
          'Conta Twilio de teste',
          'conta trial so liga para numeros verificados',
          'Adicione credito para sair do trial, ou verifique os numeros que vai testar'
        );
      }
    }
  } catch (err) {
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
    falta('Telefonia (Twilio)', `credenciais recusadas: ${String(err.message).slice(0, 50)}`, 'Confira SID e TOKEN no painel da Twilio');
  }
}

// ---------------------------------------------------------------- 4. URL publica
const url = env('PUBLIC_BASE_URL');
if (!url) {
  falta('Endereco publico', 'PUBLIC_BASE_URL vazio', 'Rode "npm run tunel" (gratis) ou hospede o sistema');
} else if (!url.startsWith('https://')) {
  falta('Endereco publico', `"${url}" nao e https`, 'A Twilio exige HTTPS');
} else {
  process.stdout.write('  testando o endereco publico...');
  try {
    const r = await fetch(url + '/health', { signal: AbortSignal.timeout(8000) });
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
    if (r.ok) ok('Endereco publico', url);
    else aviso('Endereco publico', `${url} respondeu ${r.status}`, 'O servidor precisa estar rodando');
  } catch {
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
    aviso('Endereco publico', `${url} nao respondeu`, 'Suba o servidor e o tunel antes de ligar');
  }
}

// ---------------------------------------------------------------- 5. Vendedor
// Pode vir do painel (salvo no banco) ou do .env.
const { getSetting } = await import('../server/db.js');
const salvo = getSetting('agent_phone');
const vendedor = toE164BR(salvo || env('HUMAN_AGENT_PHONE'));
if (!salvo && !env('HUMAN_AGENT_PHONE')) {
  falta(
    'Telefone do vendedor',
    'nao definido',
    'Digite no campo "Telefone do vendedor" do painel, ou preencha HUMAN_AGENT_PHONE no .env'
  );
} else if (!vendedor || !isPlausiblePhone(vendedor)) {
  falta('Telefone do vendedor', `"${env('HUMAN_AGENT_PHONE')}" nao parece valido`, 'Use o formato +5534999999999');
} else {
  ok('Telefone do vendedor', vendedor);
}

// ---------------------------------------------------------------- 6. WhatsApp
const wa = (env('WHATSAPP_PROVIDER') || 'none').toLowerCase();
if (wa === 'none') {
  aviso('WhatsApp', 'desativado (opcional)', 'Quem nao atender simplesmente nao recebe mensagem');
} else if (wa === 'meta' && (!env('META_WA_TOKEN') || !env('META_WA_PHONE_ID'))) {
  falta('WhatsApp (Meta)', 'faltam META_WA_TOKEN / META_WA_PHONE_ID', 'Pegue no painel de desenvolvedores da Meta');
} else if (wa === 'evolution' && (!env('EVOLUTION_BASE_URL') || !env('EVOLUTION_API_KEY'))) {
  falta('WhatsApp (Evolution)', 'faltam EVOLUTION_BASE_URL / EVOLUTION_API_KEY', 'Configure sua instancia da Evolution API');
} else {
  ok('WhatsApp', `provedor ${wa}`);
}

// ---------------------------------------------------------------- 7. Discurso
if (env('COMPANY_PITCH') && env('COMPANY_PITCH').length > 25) ok('Seu discurso', env('COMPANY_NAME') || 'sem nome');
else aviso('Seu discurso', 'COMPANY_PITCH generico ou vazio', 'Descreva sua oferta no .env - a IA usa isso na mensagem de WhatsApp');

// ---------------------------------------------------------------- 8. Contas
const { contarUsuarios, listarUsuarios } = await import('../server/usuarios.js');
const total = contarUsuarios();
const admins = listarUsuarios().filter((u) => u.papel === 'admin').length;
const cadastroAberto = ['1', 'true', 'sim'].includes(String(env('CADASTRO_ABERTO')).toLowerCase());

if (!total) {
  aviso('Contas', 'nenhuma conta criada', 'Abra o painel e crie a primeira: ela vira o administrador');
} else if (!admins) {
  falta('Contas', `${total} conta(s), nenhuma de admin`, 'Rode: npm run definir-admin -- email senha "Nome"');
} else {
  ok('Contas', `${total} conta(s), ${admins} admin`);
}

if (cadastroAberto) {
  aviso(
    'Cadastro publico',
    'ABERTO: qualquer um cria conta',
    'Se o sistema estiver na internet, use CADASTRO_ABERTO=false e crie os usuarios pelo painel'
  );
} else {
  ok('Cadastro publico', 'fechado (so o admin cria contas)');
}

// ---------------------------------------------------------------- relatorio
console.log('');
for (const i of itens) {
  const cor = i.estado === 'ok' ? V : i.estado === 'aviso' ? A : R;
  const marca = i.estado === 'ok' ? 'OK  ' : i.estado === 'aviso' ? '~   ' : 'FALTA';
  console.log(`  ${cor}${marca}${X} ${i.nome.padEnd(24)} ${i.detalhe}`);
  if (i.comoResolver) console.log(`        ${C}-> ${i.comoResolver}${X}`);
}

const faltando = itens.filter((i) => i.estado === 'falta');
console.log(`\n  ${'-'.repeat(60)}`);
if (!faltando.length) {
  console.log(`  ${V}Tudo pronto. As ligacoes vao sair de verdade.${X}\n`);
} else {
  console.log(`  ${R}${faltando.length} item(ns) impedem o sistema de funcionar por completo.${X}`);
  const soIA = faltando.every((i) => i.nome.includes('IA'));
  const soTel = faltando.every((i) => /Telefonia|Endereco|vendedor/.test(i.nome));
  if (soTel) console.log(`  ${A}A prospeccao ja funciona. Falta so a parte de ligar.${X}`);
  else if (soIA) console.log(`  ${A}A parte de ligacoes esta pronta; falta a IA para buscar empresas.${X}`);
  console.log('');
}
