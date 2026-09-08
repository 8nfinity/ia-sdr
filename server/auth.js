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

const assinar = (userId, validoAte) => {
  const dados = `${userId}.${validoAte}`;
  const mac = crypto.createHmac('sha256', segredo()).update(dados).digest('hex');
  return `${dados}.${mac}`;
};

function lerToken(token) {
  if (!token) return null;
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [userId, validoAte] = partes;
  if (Number(validoAte) < Date.now()) return null;

  const esperado = Buffer.from(assinar(userId, validoAte));
  const recebido = Buffer.from(token);
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return null;
  return userId;
}

const lerCookie = (req, nome) =>
  (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === nome)?.[1] ?? null;

/** Usuário da requisição, ou null. */
export function usuarioDaRequisicao(req) {
  const id = lerToken(lerCookie(req, COOKIE));
  if (!id) return null;
  const u = buscarPorId(id);
  return u && u.status === 'ativo' ? u : null;
}

export const temSessao = (req) => Boolean(usuarioDaRequisicao(req));

function darCookie(res, req, userId) {
  const validoAte = Date.now() + DIAS * 86400000;
  const seguro = req.secure || req.get('x-forwarded-proto') === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${assinar(userId, validoAte)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DIAS * 86400}` +
      (seguro ? '; Secure' : '')
  );
}

// Freio contra força bruta, por IP.
const tentativas = new Map();
const penalidade = (ip) => {
  const t = tentativas.get(ip);
  return t && Date.now() < t.ate ? Math.ceil((t.ate - Date.now()) / 1000) : 0;
};
function registrarErro(ip) {
  const t = tentativas.get(ip) ?? { erros: 0, ate: 0 };
  t.erros++;
  if (t.erros >= 5) {
    t.ate = Date.now() + Math.min(t.erros * 30000, 600000);
    t.erros = 0;
  }
  tentativas.set(ip, t);
}

export function instalarAuth(app) {
  // Quantas contas existem: a tela inicial usa para decidir entre
  // "criar a primeira conta (admin)" e "entrar".
  app.get('/api/publico/estado', (_req, res) => {
    const temUsuarios = contarUsuarios() > 0;
    res.json({ temUsuarios, cadastroAberto: !temUsuarios || config.cadastroAberto });
  });

  app.post('/api/publico/cadastro', (req, res) => {
    try {
      // A primeira conta sempre pode ser criada (e vira admin). Depois disso,
      // o cadastro aberto e uma decisao consciente: sem ele, ninguem que achar
      // a URL abre conta e gasta o credito da API do dono.
      if (contarUsuarios() > 0 && !config.cadastroAberto) {
        throw new Error('O cadastro esta fechado. Peca ao administrador para criar sua conta.');
      }
      const { nome, email, senha } = req.body ?? {};
      const usuario = criarUsuario({ nome, email, senha, limiteUsd: config.limitePadraoUsd });
      darCookie(res, req, usuario.id);
      res.json({ usuario: publico(usuario) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/publico/login', (req, res) => {
    const espera = penalidade(req.ip);
    if (espera) return res.status(429).json({ error: `Muitas tentativas. Espere ${espera}s.` });

    try {
      const usuario = autenticar(req.body?.email, req.body?.senha);
      if (!usuario) {
        registrarErro(req.ip);
        return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
      }
      darCookie(res, req, usuario.id);
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
