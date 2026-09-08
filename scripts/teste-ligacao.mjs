/**
 * Primeira ligação real, controlada.
 *
 * Cria uma "empresa" de teste com um número que VOCÊ escolhe e dispara uma
 * campanha só com ela. Serve para validar a cadeia inteira (Twilio, túnel,
 * webhooks, ponte com o vendedor) sem incomodar nenhuma empresa de verdade.
 *
 * Uso:  npm run teste-ligacao +5534988887777
 *       (esse número é o "cliente"; o HUMAN_AGENT_PHONE do .env é o vendedor)
 */
import 'dotenv/config';
import { config, voiceMode } from '../server/config.js';
import { toE164BR, isPlausiblePhone, uid, nowIso } from '../server/util.js';
import { insert, one } from '../server/db.js';

const alvo = toE164BR(process.argv[2]);
const vendedor = toE164BR(config.voice.humanAgentPhone);

const erro = (msg, dica) => {
  console.error(`\n  ERRO: ${msg}`);
  if (dica) console.error(`  -> ${dica}`);
  console.error('');
  process.exit(1);
};

if (!alvo || !isPlausiblePhone(alvo))
  erro('Informe o numero que vai receber a ligacao de teste.', 'Ex: npm run teste-ligacao +5534988887777');
if (!vendedor) erro('HUMAN_AGENT_PHONE vazio no .env.', 'E o telefone que atende primeiro.');
if (alvo === vendedor)
  erro('O numero de teste e o mesmo do vendedor.', 'Use dois numeros diferentes: um atende, o outro recebe.');
if (voiceMode() !== 'twilio')
  erro('Modo simulacao: nenhuma ligacao real sairia.', 'Preencha TWILIO_* e PUBLIC_BASE_URL. Rode: npm run checar');

// O servidor precisa estar no ar: e ele que responde os webhooks da Twilio.
try {
  const r = await fetch(`http://localhost:${config.port}/health`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error();
} catch {
  erro(`O servidor nao esta rodando na porta ${config.port}.`, 'Abra outra janela e rode: npm start');
}

// Empresa fictícia só para este teste.
const searchId = uid('sch_teste');
if (!one('SELECT 1 FROM searches WHERE id=?', searchId)) {
  insert('searches', {
    id: searchId,
    segment: 'TESTE DE LIGACAO',
    region: '-',
    quantity: 1,
    status: 'concluida',
    source: 'teste',
    log: null,
    created_at: nowIso(),
  });
}
const empresa = insert('companies', {
  id: uid('cmp_teste'),
  search_id: searchId,
  name: 'TESTE - meu proprio numero',
  phone: alvo,
  phone_e164: alvo,
  website: null,
  domain: null,
  instagram: null,
  email: null,
  address: null,
  rating: null,
  reviews: null,
  category: 'teste',
  maps_url: null,
  source: 'teste',
  score: 100,
  verdict: 'aprovada',
  reasons: '[]',
  notes: null,
  status: 'lead',
  created_at: nowIso(),
});

console.log('\n  ==========================================================');
console.log('   TESTE DE LIGACAO REAL');
console.log('  ==========================================================');
console.log(`   1. Vai tocar em ${vendedor} (voce, o vendedor)`);
console.log('   2. Atenda. Voce vai ouvir a mensagem de espera.');
console.log(`   3. Em seguida toca em ${alvo} (o "cliente")`);
console.log('   4. Atenda o segundo e fale: os dois devem se ouvir.');
console.log('  ==========================================================\n');

const res = await fetch(`http://localhost:${config.port}/api/campaigns`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ companyIds: [empresa.id], name: 'Teste de ligacao', whatsappFollowup: false }),
});
const data = await res.json();

if (!res.ok) erro(data.error ?? 'falha ao iniciar', 'Rode "npm run checar" para ver o que falta.');

console.log(`  Campanha ${data.campaignId} disparada. Atenda o telefone.`);
console.log('  Acompanhe em tempo real na aba "Ligacoes ao vivo" do painel.\n');
console.log('  Se nada tocar em 30 segundos, os suspeitos sao:');
console.log('    - Geo Permissions sem o Brasil liberado (Voice > Settings)');
console.log('    - PUBLIC_BASE_URL desatualizado (o tunel mudou de endereco)');
console.log('    - conta trial: so liga para numeros verificados\n');
