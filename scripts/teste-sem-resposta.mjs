/**
 * Testa o cenário que travou: as empresas terminam sem ninguém atender.
 * A campanha PRECISA se encerrar sozinha e liberar o vendedor.
 */
// Em ESM os imports rodam antes do corpo do arquivo, então o modo simulação
// precisa ser forçado ANTES de qualquer import que leia a configuração.
const dotenv = await import('dotenv');
dotenv.config();
process.env.TWILIO_ACCOUNT_SID = '';

const { many, one, listCompanies } = await import('../server/db.js');
const { startCampaign, engine } = await import('../server/voice/campaign.js');

const busca = many("SELECT * FROM searches WHERE status='concluida' ORDER BY created_at DESC LIMIT 1")[0];
if (!busca) {
  console.log('Rode uma busca antes (ou npm run demo).');
  process.exit(1);
}
const empresas = listCompanies(busca.id).filter((c) => c.phone_e164).slice(0, 3);

const { campaignId } = await startCampaign({
  companyIds: empresas.map((c) => c.id),
  agentPhone: '+5551981422654',
  whatsappFollowup: false,
});
console.log(`\n  Campanha ${campaignId} criada com ${empresas.length} empresas.`);

// Na simulação o vendedor atende sozinho; espera isso acontecer.
await new Promise((r) => setTimeout(r, 3000));

const calls = many('SELECT * FROM calls WHERE campaign_id=?', campaignId);
console.log(`  ${calls.length} ligações disparadas. Marcando TODAS como "nao atendeu"...\n`);

for (const c of calls) {
  await engine.onStatus({ callId: c.id, status: 'no-answer' });
}

await new Promise((r) => setTimeout(r, 500));

const campanha = one('SELECT * FROM campaigns WHERE id=?', campaignId);
const finais = many('SELECT status FROM calls WHERE campaign_id=?', campaignId);

console.log('  RESULTADO');
console.log(`    status da campanha: ${campanha.status}   (esperado: finalizada)`);
console.log(`    encerrada em:       ${campanha.ended_at ? 'sim' : 'NAO'}`);
console.log(`    ligações: ${finais.map((f) => f.status).join(', ')}`);
console.log(
  campanha.status === 'finalizada'
    ? '\n  OK: a campanha se encerrou sozinha e o vendedor seria liberado.\n'
    : '\n  FALHOU: a campanha continuaria "discando" para sempre.\n'
);
process.exit(campanha.status === 'finalizada' ? 0 : 1);
