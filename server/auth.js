/**
 * Sessão e permissões.
 *
 * Cada pessoa tem sua conta; o cookie carrega o id do usuário assinado com um
 * segredo da instalação. Os webhooks (/twiml, /webhooks) ficam de fora: quem
 * chama são a Twilio e a Meta, que têm validação própria.
 */
import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';
import { autenticar, criarUsuario, buscarPorId, publico, contarUsuarios } from './usuarios.js';
import { comUsuario } from './contexto.js';
import { config } from './config.js';
import { limitar, zerar } from './limites.js';

const COOKIE = 'iasdr_sessao';
const DIAS = 7;

function segredo() {
  let s = getSetting('segredo_sessao');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    setSetting('segredo_sessao', s);
  }
  return s;
}

// A assinatura inclui o "sal" do usuario. Como trocarSenha() gera um sal
// novo, toda troca de senha (ou reset forcado pelo admin) invalida na hora
// TODAS as sessoes antigas daquele usuario - o cookie roubado para de valer.
const assinar = (userId, validoAte, sal) => {
  const dados = `${userId}.${validoAte}`;
  const mac = crypto.createHmac('sha256', segredo()).update(`${dados}.${sal ?? ''}`).digest('hex');
  return `${dados}.${mac}`;
};

/** Retorna o usuario da sessao (ja validado), ou null. */
function usuarioDoToken(token) {
  if (!token) return null;
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [userId, validoAte] = partes;
  if (!/^\d+$/.test(validoAte) || Number(validoAte) < Date.now()) return null;

  const u = buscarPorId(userId);
  if (!u) return null;

  const esperado = Buffer.from(assinar(userId, validoAte, u.sal));
  const recebido = Buffer.from(token);
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return null;
  return u;
}

const lerCookie = (req, nome) =>
  (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === nome)?.[1] ?? null;

/** Usuário da requisição, ou null. */
export function usuarioDaRequisicao(req) {
  const u = usuarioDoToken(lerCookie(req, COOKIE));
  return u && u.status === 'ativo' ? u : null;
}

export const temSessao = (req) => Boolean(usuarioDaRequisicao(req));

function darCookie(res, req, usuario) {
  const validoAte = Date.now() + DIAS * 86400000;
  const seguro = req.secure || req.get('x-forwarded-proto') === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${assinar(usuario.id, validoAte, usuario.sal)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DIAS * 86400}` +
      (seguro ? '; Secure' : '')
  );
}

const MIN = 60000;
const emailChave = (e) => 'login_email:' + String(e ?? '').trim().toLowerCase();

export function instalarAuth(app) {
  // Quantas contas existem: a tela inicial usa para decidir entre
  // "criar a primeira conta (admin)" e "entrar".
  app.get('/api/publico/estado', (_req, res) => {
    const temUsuarios = contarUsuarios() > 0;
    res.json({ temUsuarios, cadastroAberto: !temUsuarios || config.cadastroAberto });
  });

  app.post('/api/publico/cadastro', (req, res) => {
    try {
      // Cadastro tambem e rate-limited: sem isto, alguem cria centenas de
      // contas em segundos (spam, ou pra sondar quais e-mails ja existem).
      const rl = limitar('cadastro:' + req.ip, 5, 60 * MIN);
      if (!rl.ok) return res.status(429).json({ error: `Muitas tentativas. Espere ${rl.retryS}s.` });

      // A primeira conta sempre pode ser criada (e vira admin). Depois disso,
      // o cadastro aberto e uma decisao consciente: sem ele, ninguem que achar
      // a URL abre conta e gasta o credito da API do dono.
      if (contarUsuarios() > 0 && !config.cadastroAberto) {
        throw new Error('O cadastro esta fechado. Peca ao administrador para criar sua conta.');
      }
      const { nome, email, senha } = req.body ?? {};
      const usuario = criarUsuario({ nome, email, senha, limiteUsd: config.limitePadraoUsd });
      darCookie(res, req, usuario);
      res.json({ usuario: publico(usuario) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/publico/login', (req, res) => {
    // Dois freios: por IP (contra varredura) e por e-mail (contra forca bruta
    // distribuida em varios IPs contra UMA conta). Conta so as tentativas
    // erradas; o acerto zera os dois.
    const porIp = limitar('login_ip:' + req.ip, 15, 10 * MIN);
    if (!porIp.ok) return res.status(429).json({ error: `Muitas tentativas. Espere ${porIp.retryS}s.` });
    const chaveEmail = emailChave(req.body?.email);
    const porEmail = limitar(chaveEmail, 8, 15 * MIN);
    if (!porEmail.ok) return res.status(429).json({ error: `Muitas tentativas nesta conta. Espere ${porEmail.retryS}s.` });

    try {
      const usuario = autenticar(req.body?.email, req.body?.senha);
      if (!usuario) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
      zerar('login_ip:' + req.ip);
      zerar(chaveEmail);
      darCookie(res, req, usuario);
      res.json({ usuario: publico(usuario) });
    } catch (err) {
      res.status(403).json({ error: err.message });
    }
  });

  app.post('/api/publico/sair', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // Daqui para baixo, tudo exige sessão.
  app.use((req, res, next) => {
    // Folhas de estilo e fontes precisam ser livres: a propria tela de login
    // usa o CSS, e bloquea-lo devolve HTML no lugar do arquivo - a pagina
    // aparece crua e ninguem entende por que.
    const livre =
      req.path.startsWith('/twiml/') ||
      req.path.startsWith('/webhooks/') ||
      req.path.startsWith('/api/publico/') ||
      req.path.endsWith('.css') ||
      ['/health', '/entrar.html', '/entrar.js'].includes(req.path);
    if (livre) return next();

    const usuario = usuarioDaRequisicao(req);
    if (!usuario) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'faca login para continuar' });
      return res.redirect('/entrar.html');
    }

    // A partir daqui, todo o resto do sistema sabe de quem é o dado.
    comUsuario(usuario, () => {
      req.usuario = usuario;
      next();
    });
  });

  // Área do administrador.
  app.use('/api/admin', (req, res, next) => {
    if (req.usuario?.papel !== 'admin') return res.status(403).json({ error: 'area restrita ao administrador' });
    next();
  });
}
