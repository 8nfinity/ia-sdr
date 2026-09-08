/**
 * Popula o painel de administração com dados fictícios (usuários, gastos e
 * atividade) só para ver a tela cheia. Marcado com [DEMO] no nome.
 */
import { insert, one, many } from '../server/db.js';
import { criarUsuario, buscarPorEmail } from '../server/usuarios.js';
import { uid, nowIso } from '../server/util.js';

const pessoas = [
  { nome: 'Ana Prospecção [DEMO]', email: 'ana.demo@teste.com', gastos: [0.42, 0.31, 0.55, 0.18], leads: 34, ligacoes: 22, atendidas: 5 },
  { nome: 'Bruno Vendas [DEMO]', email: 'bruno.demo@teste.com', gastos: [0.12, 0.09], leads: 11, ligacoes: 8, atendidas: 1 },
  { nome: 'Carla SDR [DEMO]', email: 'carla.demo@teste.com', gastos: [0.88, 0.61, 0.44], leads: 52, ligacoes: 41, atendidas: 9 },
];

const diasAtras = (n) => new Date(Date.now() - n * 86400000).toISOString();

for (const p of pessoas) {
  let u = buscarPorEmail(p.email);
  if (!u) u = criarUsuario({ nome: p.nome, email: p.email, senha: 'demo123456' });

  p.gastos.forEach((usd, i) => {
    insert('uso', {
      id: uid('uso_'),
      tipo: i % 2 ? 'busca:web' : 'busca:auditoria',
      ref_id: null,
      modelo: 'claude-sonnet-5',
      entrada: Math.round(usd * 20000),
      saida: Math.round(usd * 900),
      cache: 0,
      buscas: i + 1,
      usd,
      created_at: diasAtras(i + 1),
      user_id: u.id,
    });
  });

  const searchId = uid('sch_demo');
  insert('searches', {
    id: searchId,
    segment: 'clinicas [DEMO]',
    region: 'Porto Alegre, RS',
    quantity: p.leads,
    status: 'concluida',
    source: 'demo',
    log: null,
    created_at: diasAtras(2),
    user_id: u.id,
  });

  for (let i = 0; i < p.leads; i++) {
    insert('companies', {
      id: uid('cmp_demo'),
      search_id: searchId,
      name: `Empresa demo ${i + 1}`,
      phone_e164: '+555199000' + String(1000 + i),
      score: 70,
      status: 'novo',
      reasons: '[]',
      created_at: diasAtras(2),
      user_id: u.id,
    });
  }

  const campId = uid('cmp_demo');
  insert('campaigns', {
    id: campId,
    name: 'Campanha demo',
    status: 'finalizada',
    conference: 'iasdr_sala',
    mode: 'twilio',
    modo: 'direto',
    created_at: diasAtras(1),
    user_id: u.id,
  });

  for (let i = 0; i < p.ligacoes; i++) {
    insert('calls', {
      id: uid('cl_demo'),
      campaign_id: campId,
      company_id: null,
      to_number: '+555199000' + String(1000 + i),
      status: i < p.atendidas ? 'encerrada' : 'no-answer',
      is_winner: i < p.atendidas ? 1 : 0,
      transcript: '[]',
      created_at: diasAtras(1),
      user_id: u.id,
    });
  }
}

console.log(`\n  ${pessoas.length} usuários de demonstração criados (senha: demo123456).`);
console.log('  Abra /admin.html para ver o painel cheio.');
console.log('  Para limpar: apague a pasta data/\n');
