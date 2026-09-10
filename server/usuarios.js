/**
 * Usuários, senhas e permissões.
 *
 * Senha nunca é guardada: fica só o hash scrypt com sal próprio de cada
 * usuário (algoritmo do próprio Node, sem dependência externa). Mesmo com o
 * banco na mão, ninguém lê a senha de ninguém.
 */
import crypto from 'node:crypto';
import { db, insert, update, one, many } from './db.js';
import { uid, nowIso } from './util.js';

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  nome TEXT,
  email TEXT UNIQUE,
  senha_hash TEXT,
  sal TEXT,
  papel TEXT DEFAULT 'usuario',
  status TEXT DEFAULT 'ativo',
  limite_usd REAL,
  created_at TEXT,
  ultimo_acesso TEXT,
  plano TEXT,
  assinatura_status TEXT DEFAULT 'nenhuma',
  assinatura_id_mp TEXT,
  periodo_inicio TEXT,
  periodo_fim TEXT,
  creditos_buscas INTEGER DEFAULT 0,
  creditos_ligacoes INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
`);

const normalizarEmail = (e) => String(e ?? '').trim().toLowerCase();

const hash = (senha, sal) =>
  crypto.scryptSync(String(senha), sal, 64, { N: 16384, r: 8, p: 1 }).toString('hex');

/** Comparação em tempo constante: não vaza a senha pelo tempo de resposta. */
function conferir(senha, usuario) {
  const calculado = Buffer.from(hash(senha, usuario.sal));
  const guardado = Buffer.from(usuario.senha_hash);
  return calculado.length === guardado.length && crypto.timingSafeEqual(calculado, guardado);
}

export const contarUsuarios = () => one('SELECT COUNT(*) n FROM usuarios')?.n ?? 0;
export const buscarPorEmail = (email) => one('SELECT * FROM usuarios WHERE email=?', normalizarEmail(email));
export const buscarPorId = (id) => one('SELECT * FROM usuarios WHERE id=?', id);

/** Regras minimas de senha - usadas no cadastro e na troca de senha. */
export function validarSenha(senha, email = '') {
  const s = String(senha ?? '');
  if (s.length < 8) throw new Error('A senha precisa de pelo menos 8 caracteres.');
  if (s.length > 200) throw new Error('Senha longa demais.');
  const fracas = ['12345678', 'senha123', 'password', '123456789', 'qwertyui', 'iasdr123'];
  if (fracas.includes(s.toLowerCase())) throw new Error('Essa senha e muito comum. Escolha outra.');
  if (email && s.toLowerCase() === normalizarEmail(email)) throw new Error('A senha nao pode ser o proprio e-mail.');
}

export function criarUsuario({ nome, email, senha, papel, limiteUsd = null }) {
  const mail = normalizarEmail(email);
  if (!nome || nome.trim().length < 2) throw new Error('Informe seu nome.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new Error('E-mail invalido.');
  validarSenha(senha, mail);
  if (buscarPorEmail(mail)) throw new Error('Ja existe uma conta com esse e-mail.');

  const sal = crypto.randomBytes(16).toString('hex');
  // O primeiro a se cadastrar vira admin: alguem precisa administrar o resto.
  const primeiro = contarUsuarios() === 0;

  const usuario = {
    id: uid('usr_'),
    nome: nome.trim(),
    email: mail,
    senha_hash: hash(senha, sal),
    sal,
    papel: papel ?? (primeiro ? 'admin' : 'usuario'),
    status: 'ativo',
    // Admin nunca tem teto; quem se cadastra sozinho herda o teto padrao.
    limite_usd: primeiro || papel === 'admin' ? null : limiteUsd,
    created_at: nowIso(),
    ultimo_acesso: null,
  };
  insert('usuarios', usuario);
  return usuario;
}

export function autenticar(email, senha) {
  const usuario = buscarPorEmail(email);
  // Mesmo sem usuario, calcula um hash: evita descobrir e-mails validos
  // medindo o tempo de resposta.
  if (!usuario) {
    hash(String(senha ?? ''), 'sal-inexistente');
    return null;
  }
  if (!conferir(senha, usuario)) return null;
  if (usuario.status !== 'ativo') throw new Error('Sua conta esta bloqueada. Fale com o administrador.');

  update('usuarios', usuario.id, { ultimo_acesso: nowIso() });
  return usuario;
}

export function trocarSenha(id, senhaNova) {
  const u = buscarPorId(id);
  validarSenha(senhaNova, u?.email);
  // Sal novo => o HMAC da sessao muda => todos os cookies antigos deste
  // usuario param de valer na hora (ver server/auth.js).
  const sal = crypto.randomBytes(16).toString('hex');
  update('usuarios', id, { sal, senha_hash: hash(senhaNova, sal) });
}

/** Dados do usuário seguros para mandar ao navegador (sem hash nem sal). */
export const publico = (u) =>
  u && {
    id: u.id,
    nome: u.nome,
    email: u.email,
    papel: u.papel,
    status: u.status,
    limiteUsd: u.limite_usd,
    criadoEm: u.created_at,
    ultimoAcesso: u.ultimo_acesso,
    plano: u.plano,
    assinaturaStatus: u.assinatura_status,
    periodoInicio: u.periodo_inicio,
    periodoFim: u.periodo_fim,
    creditosBuscas: u.creditos_buscas ?? 0,
    creditosLigacoes: u.creditos_ligacoes ?? 0,
  };

export const listarUsuarios = () => many('SELECT * FROM usuarios ORDER BY created_at ASC').map(publico);
