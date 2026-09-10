import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, integrationStatus, voiceMode } from './config.js';
import { attachRealtime, log } from './realtime.js';
import { apiRouter } from './routes/api.js';
import { adminRouter } from './routes/admin.js';
import { crmRouter } from './routes/crm.js';
import { pagamentosRouter } from './routes/pagamentos.js';
import { webhooksMpRouter } from './routes/webhooks-mp.js';
import { twimlRouter } from './voice/twiml.js';
import { whatsappRouter } from './whatsapp/index.js';
import { registrarUso, bancoEm, getSetting, definirDonoAtual } from './db.js';
import { idDoUsuario } from './contexto.js';
import { instalarAuth } from './auth.js';
import { limitar } from './limites.js';
import { contarUsuarios } from './usuarios.js';
import { definirVendedorSalvo } from './config.js';
import { registrarUsoCom } from './ai/claude.js';

// Toda chamada de API vira uma linha no banco: e assim que o painel mostra
// quanto custou cada busca e cada ligacao, em vez de estimativa.
registrarUsoCom(registrarUso);

// Todo dado gravado sai carimbado com o dono da sessao.
definirDonoAtual(idDoUsuario);

// Telefone do vendedor salvo pelo painel volta a valer depois de reiniciar.
definirVendedorSalvo(getSetting('agent_phone'));

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '512kb' })); // webhooks Twilio chegam como form

// Atras de proxy (Nginx, Railway, Render) o IP real vem no cabecalho.
app.set('trust proxy', 1);

// Cabecalhos de seguranca (sem depender do helmet - sao poucos).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY'); // nao pode ser embutido em iframe (clickjacking)
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  // CSP: o painel so carrega o que vem do proprio dominio + as fontes do
  // Google e o SDK do Mercado Pago (checkout). connect-src inclui wss para o
  // WebSocket do painel.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
      "script-src 'self' https://sdk.mercadopago.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "img-src 'self' data: https:; " +
      "media-src 'self'; " +
      "frame-src https://sdk.mercadopago.com https://*.mercadopago.com; " +
      "connect-src 'self' https://api.mercadopago.com wss: ws:; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
});

// Rate limit geral do painel (por IP). Nao pega webhooks (Twilio/Meta/MP
// tem rajadas legitimas) nem os arquivos estaticos.
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/publico/')) return next(); // login/cadastro tem limite proprio
  const { ok, retryS } = limitarApi(req.ip, req.method);
  if (ok) return next();
  res.set('Retry-After', String(retryS));
  res.status(429).json({ error: `Muitas requisições. Tente de novo em ${retryS}s.` });
});
function limitarApi(ip, metodo) {
  // Leituras: teto alto. Escritas: mais apertado (é onde dá pra abusar).
  const escrita = metodo !== 'GET' && metodo !== 'HEAD';
  return limitar(`api:${escrita ? 'w' : 'r'}:${ip}`, escrita ? 120 : 600, 60000);
}

/**
 * Descobre o proprio endereco publico na primeira visita.
 *
 * Em hospedagem (Northflank, Render, Railway) a URL so existe depois do
 * primeiro deploy, entao ninguem consegue preencher PUBLIC_BASE_URL antes.
 * Sem ele, a busca funciona mas a ligacao cai no "alo" - falha silenciosa e
 * dificil de entender. Aqui o servidor aprende o endereco pelo cabecalho da
 * requisicao. Preencher PUBLIC_BASE_URL continua valendo e tem prioridade.
 */
app.use((req, _res, next) => {
  if (!config.publicBaseUrl) {
    const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    const ehLocal = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/.test(host);
    // So aceita um hostname bem formado (letras/numeros/hifen/ponto + porta
    // opcional) e sob https. Sem isto, um "Host:" forjado na PRIMEIRA
    // requisicao apos o deploy envenenaria a URL usada nos callbacks da
    // Twilio e no retorno do Mercado Pago. O jeito 100% seguro e definir
    // PUBLIC_BASE_URL nas variaveis de ambiente (tem prioridade sobre isto).
    const hostValido = /^[a-z0-9.-]+(:\d{2,5})?$/i.test(host) && !host.includes('..');
    const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
    if (host && !ehLocal && hostValido && proto === 'https') {
      config.publicBaseUrl = `https://${host}`;
      log('sistema', `endereco publico detectado automaticamente: ${config.publicBaseUrl}`);
      console.log(`\n  Endereco publico detectado: ${config.publicBaseUrl}`);
      console.log('  (para fixar/proteger, defina PUBLIC_BASE_URL nas variaveis de ambiente)\n');
    }
  }
  next();
});

// Senha do painel: precisa vir ANTES das rotas que gastam dinheiro.
instalarAuth(app);

app.use('/api/admin', adminRouter);
app.use('/api/crm', crmRouter);
app.use('/api/pagamentos', pagamentosRouter);
app.use('/api', apiRouter);
app.use('/twiml', twimlRouter);
app.use('/webhooks/whatsapp', whatsappRouter);
app.use('/webhooks/mercadopago', webhooksMpRouter);
app.use(express.static(path.join(here, '..', 'web')));

app.get('/health', (_req, res) => res.json({ ok: true, voz: voiceMode() }));

const server = http.createServer(app);
attachRealtime(server);

// Rede de seguranca: porta ocupada nao pode virar stack trace na cara do usuario.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error('  ================================================================');
    console.error(`  A porta ${config.port} ja esta em uso.`);
    console.error('  ================================================================');
    console.error('  Provavel causa: um servidor do IA SDR ainda esta rodando.');
    console.error('');
    console.error('  Feche a outra janela do terminal, ou rode:');
    console.error('     taskkill /F /IM node.exe        (Windows)');
    console.error('');
    console.error('  Depois rode "npm start" de novo. Para usar outra porta:');
    console.error('     defina PORT=3001 no arquivo .env');
    console.error('');
    process.exit(1);
  }
  console.error('  Erro no servidor:', err.message);
  process.exit(1);
});

server.listen(config.port, () => {
  const status = integrationStatus();
  console.log('');
  console.log('  IA SDR rodando em  http://localhost:' + config.port);
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (lan) console.log(`  no celular (mesma rede):  http://${lan}:${config.port}`);
  console.log('  banco: ' + bancoEm);
  console.log('  ------------------------------------------------');
  for (const [nome, s] of Object.entries(status)) {
    console.log(`  ${s.ok ? '[ok]  ' : '[--]  '}${nome.padEnd(12)} ${s.detail}`);
  }
  if (contarUsuarios() === 0) {
    console.log('');
    console.log('  Nenhuma conta criada ainda.');
    console.log('  Abra o painel e crie a primeira: ela vira o ADMINISTRADOR.');
  }
  if (!status.prospeccao.ok) {
    console.log('');
    console.log('  ###############################################################');
    console.log('  #  A BUSCA NAO VAI FUNCIONAR: falta a chave da IA.            #');
    console.log('  #                                                             #');
    console.log('  #  1. Pegue a chave em console.anthropic.com                  #');
    console.log('  #  2. Abra o arquivo .env e preencha:                         #');
    console.log('  #        ANTHROPIC_API_KEY=sk-ant-...                         #');
    console.log('  #  3. Pare aqui (Ctrl+C) e rode "npm start" de novo           #');
    console.log('  ###############################################################');
  }
  if (voiceMode() === 'simulation') {
    console.log('');
    console.log('  MODO SIMULACAO: as ligacoes nao saem de verdade.');
    console.log('  Preencha TWILIO_* e PUBLIC_BASE_URL no .env para ligar mesmo.');
  }
  if (config.publicBaseUrl) {
    console.log('');
    console.log('  Webhook WhatsApp: ' + config.publicBaseUrl + '/webhooks/whatsapp');
  }
  if (voiceMode() === 'twilio' && !config.twilio.validateSignature) {
    console.log('');
    console.log('  !! SEGURANCA: TWILIO_VALIDATE_SIGNATURE=false.');
    console.log('     Sem isso, qualquer um pode forjar eventos de ligacao no /twiml.');
    console.log('     Defina TWILIO_VALIDATE_SIGNATURE=true no .env (e confira que');
    console.log('     PUBLIC_BASE_URL bate exatamente com o dominio publico).');
  }
  if (config.mercadopago.accessToken && !config.mercadopago.webhookSecret) {
    console.log('');
    console.log('  !! SEGURANCA: MERCADOPAGO_WEBHOOK_SECRET vazio - o webhook de');
    console.log('     pagamento aceita qualquer POST. Defina o secret do Console.');
  }
  console.log('');
  log('sistema', 'servidor iniciado');
});

process.on('unhandledRejection', (err) => log('sistema', `promessa rejeitada: ${err?.message ?? err}`));
