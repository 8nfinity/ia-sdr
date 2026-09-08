/**
 * Define (ou redefine) a conta de administrador.
 *
 * Uso:  npm run definir-admin -- email@dominio.com SenhaSegura "Seu Nome"
 *
 * Também adota os dados órfãos: tudo que foi criado antes de existirem contas
 * (as buscas e campanhas dos primeiros testes) passa a pertencer ao admin, em
 * vez de ficar sem dono e sumir das listagens.
 */
import { db, one, update, many } from '../server/db.js';
import { criarUsuario, buscarPorEmail, trocarSenha, publico } from '../server/usuarios.js';

const [email, senha, ...resto] = process.argv.slice(2);
const nome = resto.join(' ') || 'Administrador';

if (!email || !senha) {
  console.error('\n  Uso: npm run definir-admin -- email@dominio.com SuaSenha "Seu Nome"\n');
  process.exit(1);
}

let usuario = buscarPorEmail(email);
if (usuario) {
  trocarSenha(usuario.id, senha);
  update('usuarios', usuario.id, { papel: 'admin', status: 'ativo', nome });
  console.log(`\n  Conta ${email} atualizada: senha trocada e papel de ADMIN garantido.`);
} else {
  usuario = criarUsuario({ nome, email, senha, papel: 'admin' });
  console.log(`\n  Conta de administrador criada: ${email}`);
}
usuario = buscarPorEmail(email);

// Dados criados antes de existir login ficam sem dono; adota tudo.
let adotados = 0;
for (const tabela of ['searches', 'companies', 'campaigns', 'calls', 'messages', 'uso', 'wa_fila']) {
  try {
    const r = db.prepare(`UPDATE ${tabela} SET user_id=? WHERE user_id IS NULL`).run(usuario.id);
    adotados += Number(r.changes);
  } catch { /* tabela pode nao existir ainda */ }
}
if (adotados) console.log(`  ${adotados} registros sem dono foram atribuidos a esta conta.`);

// Limpa contas de teste/demonstracao, se ainda existirem.
const lixo = many(
  "SELECT id, email FROM usuarios WHERE email LIKE '%@teste.com' OR nome LIKE '%[DEMO]%'"
);
for (const u of lixo) {
  for (const tabela of ['searches', 'companies', 'campaigns', 'calls', 'messages', 'uso', 'wa_fila']) {
    try { db.prepare(`DELETE FROM ${tabela} WHERE user_id=?`).run(u.id); } catch { /* ok */ }
  }
  db.prepare('DELETE FROM usuarios WHERE id=?').run(u.id);
}
if (lixo.length) console.log(`  ${lixo.length} conta(s) de teste removidas: ${lixo.map((u) => u.email).join(', ')}`);

const total = one('SELECT COUNT(*) n FROM usuarios')?.n ?? 0;
console.log(`\n  Contas no sistema: ${total}`);
console.log(`  Entre em http://localhost:3000/entrar.html com ${email}\n`);
console.log('  ' + JSON.stringify(publico(buscarPorEmail(email))) + '\n');
