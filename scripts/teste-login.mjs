/**
 * Testa contas, isolamento de dados e área do admin.
 * O ponto crítico é o isolamento: um usuário jamais pode ver o lead do outro.
 */
const API = 'http://localhost:3000';
let falhas = 0;
const checar = (nome, ok, detalhe = '') => {
  console.log(`  ${ok ? 'OK  ' : 'FALHOU'} ${nome}${detalhe ? ' — ' + detalhe : ''}`);
  if (!ok) falhas++;
};

/** Cliente HTTP que guarda o cookie da sessão, como um navegador faria. */
function criarCliente() {
  let cookie = '';
  return async (rota, opcoes = {}) => {
    const res = await fetch(API + rota, {
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      redirect: 'manual',
      ...opcoes,
      body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const texto = await res.text();
    let dados = null;
    try { dados = JSON.parse(texto); } catch { dados = texto; }
    return { status: res.status, dados };
  };
}

// ─── 1. sem sessão, nada passa ───
const anonimo = criarCliente();
checar('API bloqueada sem login', (await anonimo('/api/status')).status === 401);
checar('painel redireciona para o login', (await anonimo('/')).status === 302);
checar('webhook da Twilio continua livre', (await anonimo('/twiml/status/x', { method: 'POST' })).status === 204);

// ─── 2. primeira conta vira admin ───
const admin = criarCliente();
const r1 = await admin('/api/publico/cadastro', {
  method: 'POST',
  body: { nome: 'Dono do Sistema', email: 'admin@teste.com', senha: 'senha123' },
});
checar('primeira conta criada', r1.status === 200, r1.dados?.error);
checar('primeira conta é ADMIN', r1.dados?.usuario?.papel === 'admin', r1.dados?.usuario?.papel);

// ─── 3. segunda conta é usuário comum ───
const joao = criarCliente();
const r2 = await joao('/api/publico/cadastro', {
  method: 'POST',
  body: { nome: 'Joao Vendedor', email: 'joao@teste.com', senha: 'senha123' },
});
checar('segunda conta é usuário comum', r2.dados?.usuario?.papel === 'usuario', r2.dados?.usuario?.papel);

const maria = criarCliente();
await maria('/api/publico/cadastro', {
  method: 'POST',
  body: { nome: 'Maria Vendedora', email: 'maria@teste.com', senha: 'senha123' },
});

// ─── 4. e-mail repetido e senha curta ───
const dup = await criarCliente()('/api/publico/cadastro', {
  method: 'POST',
  body: { nome: 'Outro', email: 'joao@teste.com', senha: 'senha123' },
});
checar('e-mail duplicado recusado', dup.status === 400, dup.dados?.error);
const curta = await criarCliente()('/api/publico/cadastro', {
  method: 'POST',
  body: { nome: 'X', email: 'x@teste.com', senha: '123' },
});
checar('senha curta recusada', curta.status === 400, curta.dados?.error);

// ─── 5. login com senha errada ───
const errada = await criarCliente()('/api/publico/login', {
  method: 'POST',
  body: { email: 'joao@teste.com', senha: 'errada' },
});
checar('senha errada recusada', errada.status === 401);

// ─── 6. ISOLAMENTO: cada um só vê o que é seu ───
const listaJoao = 'Nome;Telefone\nCliente do Joao;5133445566';
const listaMaria = 'Nome;Telefone\nCliente da Maria;5199887766';
const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');

await joao('/api/importar', { method: 'POST', body: { arquivo: b64(listaJoao), nome: 'joao.csv' } });
await maria('/api/importar', { method: 'POST', body: { arquivo: b64(listaMaria), nome: 'maria.csv' } });

const buscasJoao = (await joao('/api/searches')).dados;
const buscasMaria = (await maria('/api/searches')).dados;
checar('João vê só a lista dele', buscasJoao.length === 1 && buscasJoao[0].segment.includes('joao.csv'));
checar('Maria vê só a lista dela', buscasMaria.length === 1 && buscasMaria[0].segment.includes('maria.csv'));
checar(
  'João NÃO vê a lista da Maria',
  !buscasJoao.some((b) => b.segment.includes('maria')),
  JSON.stringify(buscasJoao.map((b) => b.segment))
);

const adminBuscas = (await admin('/api/searches')).dados;
checar('admin vê tudo', adminBuscas.length === 2, `${adminBuscas.length} buscas`);

// ─── 7. área do admin é restrita ───
checar('usuário comum barrado no admin', (await joao('/api/admin/painel')).status === 403);
const painel = await admin('/api/admin/painel');
checar('admin acessa o painel', painel.status === 200);
checar('painel lista os 3 usuários', painel.dados?.usuarios?.length === 3, `${painel.dados?.usuarios?.length}`);
checar(
  'painel conta os leads por usuário',
  painel.dados.usuarios.find((u) => u.email === 'joao@teste.com')?.leads === 1
);

// ─── 8. limite de gasto ───
// Limite acima do gasto: passa. (João ainda não gastou nada em API.)
await admin(`/api/admin/usuarios/${r2.dados.usuario.id}`, { method: 'PATCH', body: { limiteUsd: 10 } });
const comFolga = await joao('/api/search', {
  method: 'POST',
  body: { segment: 'teste', region: 'teste', quantity: 1 },
});
checar('limite com folga deixa buscar', comFolga.status === 202, JSON.stringify(comFolga.dados));

// Limite zero: bloqueia tudo, inclusive quem nunca gastou.
await admin(`/api/admin/usuarios/${r2.dados.usuario.id}`, { method: 'PATCH', body: { limiteUsd: 0 } });
const bloqueada = await joao('/api/search', {
  method: 'POST',
  body: { segment: 'teste', region: 'teste', quantity: 1 },
});
checar(
  'limite zerado bloqueia a busca',
  bloqueada.status === 400 && /limite/i.test(bloqueada.dados?.error ?? ''),
  bloqueada.dados?.error
);

// Campanha também respeita o limite.
const campanha = await joao('/api/campaigns', { method: 'POST', body: { companyIds: ['x'] } });
checar('limite bloqueia a campanha', /limite/i.test(campanha.dados?.error ?? ''), campanha.dados?.error);

// ─── 9. bloquear usuário derruba o acesso ───
await admin(`/api/admin/usuarios/${r2.dados.usuario.id}`, { method: 'PATCH', body: { status: 'bloqueado' } });
checar('usuário bloqueado perde acesso', (await joao('/api/status')).status === 401);
const tentaLogar = await criarCliente()('/api/publico/login', {
  method: 'POST',
  body: { email: 'joao@teste.com', senha: 'senha123' },
});
checar('usuário bloqueado não loga', tentaLogar.status === 403, tentaLogar.dados?.error);

// ─── 10. admin não pode se auto-bloquear ───
const auto = await admin(`/api/admin/usuarios/${r1.dados.usuario.id}`, {
  method: 'PATCH',
  body: { status: 'bloqueado' },
});
checar('admin não bloqueia a si mesmo', auto.status === 400, auto.dados?.error);

console.log(falhas ? `\n  ${falhas} teste(s) falharam\n` : '\n  Todos os testes passaram\n');
process.exit(falhas ? 1 : 0);
