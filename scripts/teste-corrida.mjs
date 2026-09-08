/**
 * Teste ponta a ponta do discador paralelo (modo simulacao).
 * Fluxo testado: vendedor atende -> empresas sao discadas -> a primeira que
 * atende cai na linha dele -> todas as outras caem.
 */
const API = 'http://localhost:3000/api';

// Este teste usa numeros ficticios. Rodar com telefonia real discaria de
// verdade para eles - entao ele se recusa a rodar fora da simulacao.
const status = await fetch(API + '/status').then((r) => r.json()).catch(() => null);
if (!status) {
  console.log('\n  O servidor nao esta rodando. Rode "npm start" em outra janela.\n');
  process.exit(1);
}
if (status.modoVoz === 'twilio') {
  console.log('\n  Este teste e SO para o modo simulacao: ele disca para numeros ficticios.');
  console.log('  Seu sistema esta em modo REAL (Twilio configurada).');
  console.log('  Para testar de verdade, use:  npm run teste-ligacao +55SEUNUMERO\n');
  process.exit(1);
}
const req = async (p, body) => {
  const r = await fetch(API + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const buscas = await req('/searches');
const busca = buscas.find((b) => b.status === 'concluida');
if (!busca) {
  console.log('Nenhuma busca concluida. Rode "npm run demo" primeiro.');
  process.exit(1);
}
const { companies } = await req('/searches/' + busca.id);

console.log(`\n1. Chamando o vendedor. As ${companies.length} empresas so serao discadas depois que ele atender.`);
const inicio = await req('/campaigns', {
  companyIds: companies.map((c) => c.id),
  agentPhone: '+5534999999999',
  whatsappFollowup: false,
});
console.log(`   aguardandoVendedor: ${inicio.aguardandoVendedor === true}`);

let vencedora = null;
let estado = null;
for (let i = 0; i < 25 && !vencedora; i++) {
  await espera(1000);
  estado = await req('/campaigns/' + inicio.campaignId);
  vencedora = estado.calls.find((c) => c.is_winner);
  if (i === 1) {
    const discando = estado.calls.filter((c) => c.status !== 'criada').length;
    console.log(`\n2. Vendedor atendeu -> ${discando} empresas discadas ao mesmo tempo.`);
  }
}

console.log('\n3. Resultado da corrida:');
for (const c of estado.calls) {
  const marca = c.is_winner ? '>> NA LINHA COM O VENDEDOR' : '   ' + c.status;
  console.log(`   ${marca.padEnd(28)} ${(c.company?.name ?? '').slice(0, 32)}`);
}

if (!vencedora) {
  console.log('\n   Ninguem atendeu nesta rodada (a simulacao sorteia). Rode de novo.');
  process.exit(0);
}

const derrubadas = estado.calls.filter((c) => c.outcome?.includes('outra empresa')).length;
console.log(`\n4. Conferencia: ${vencedora.status} | vendedor: ${vencedora.agent_state}`);
console.log(`   Ligacoes encerradas automaticamente: ${derrubadas}`);
// A API ja devolve a transcricao como lista.
const falas = Array.isArray(vencedora.transcript) ? vencedora.transcript : [];
console.log(`   Falas de IA na ligacao: ${falas.length} (esperado: 0 no modo direto)\n`);
