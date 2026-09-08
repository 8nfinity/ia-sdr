/**
 * Popula o painel com empresas FICTICIAS para você ver a interface funcionando
 * sem gastar API. Rode: npm run demo
 * As empresas ficam marcadas com "[DEMO]" no nome e os telefones sao invalidos
 * para ligacao real (prefixo 5511 9000-xxxx).
 */
import { insert, saveCompany } from '../server/db.js';
import { uid, nowIso } from '../server/util.js';

const searchId = uid('sch_demo');
insert('searches', {
  id: searchId,
  segment: 'clinicas odontologicas [DEMO]',
  region: 'Zona Sul, Sao Paulo - SP',
  quantity: 8,
  status: 'concluida',
  source: 'demo',
  log: JSON.stringify({ demo: true }),
  created_at: nowIso(),
});

const demo = [
  ['Odonto Vida [DEMO]', 'odontovida.com.br', '@odontovida', 412, 4.8, 96],
  ['Sorriso Perfeito Odontologia [DEMO]', 'sorrisoperfeito.com.br', '@sorrisoperfeito', 287, 4.7, 92],
  ['Clinica Dental Prime [DEMO]', 'dentalprime.com.br', '@dentalprime', 154, 4.6, 88],
  ['OdontoCenter Moema [DEMO]', 'odontocenter.com.br', null, 98, 4.4, 74],
  ['Implantes Sao Paulo [DEMO]', 'implantessp.com.br', '@implantessp', 63, 4.9, 81],
  ['Dr. Sorriso Odontologia [DEMO]', null, '@drsorrisoodonto', 41, 4.3, 63],
  ['Clinica Bem Sorrir [DEMO]', 'bemsorrir.com.br', '@bemsorrir', 22, 4.1, 58],
  ['Odonto Familia Ipiranga [DEMO]', null, null, 12, 4.0, 47],
];

demo.forEach(([name, site, insta, reviews, rating, score], i) => {
  saveCompany(searchId, {
    name,
    phone: `(11) 9000-${1000 + i}`,
    phoneE164: `+55119000${1000 + i}`,
    website: site ? `https://${site}` : null,
    domain: site,
    instagram: insta,
    email: site ? `contato@${site}` : null,
    address: `Rua Exemplo, ${100 + i * 37} - Sao Paulo/SP`,
    rating,
    reviews,
    category: 'Clinica odontologica',
    source: 'demo',
    score,
    verdict: 'aprovada',
    reasons: ['telefone valido', site ? 'site proprio no ar' : 'sem site', `${reviews} avaliacoes no Maps`],
  });
});

console.log(`\n  ${demo.length} empresas de demonstracao criadas.`);
console.log('  Rode "npm start" e abra http://localhost:3000');
console.log(`  Elas aparecem ao abrir: http://localhost:3000/api/searches/${searchId}\n`);
console.log('  Para limpar: apague a pasta data/\n');
