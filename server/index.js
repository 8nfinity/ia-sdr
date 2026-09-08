import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, integrationStatus, voiceMode } from './config.js';
import { attachRealtime, log } from './realtime.js';
import { apiRouter } from './routes/api.js';
import { adminRouter } from './routes/admin.js';
import { twimlRouter } from './voice/twiml.js';
import { whatsappRouter } from './whatsapp/index.js';
import { registrarUso, bancoEm, getSetting, definirDonoAtual } from './db.js';
import { idDoUsuario } from './contexto.js';
import { instalarAuth } from './auth.js';
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

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false })); // webhooks Twilio chegam como form

// Atras de proxy (Nginx, Railway, Render) o IP real vem no cabecalho.
app.set('trust proxy', 1);

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
    const host = req.get('x-forwarded-host') || req.get('host') || '';
    const ehLocal = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/.test(host);
    if (host && !ehLocal) {
      const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
      config.publicBaseUrl = `${proto}://${host}`;
      log('sistema', `endereco publico detectado automaticamente: ${config.publicBaseUrl}`);
      console.log(`\n  Endereco publico detectado: ${config.publicBaseUrl}`);
      console.log('  (para fixar, defina PUBLIC_BASE_URL nas variaveis de ambiente)\n');
    }
  }
  next();
});

// Senha do painel: precisa vir ANTES das rotas que gastam dinheiro.
instalarAuth(app);

app.use('/api/admin', adminRouter);
app.use('/api', apiRouter);
app.use('/twiml', twimlRouter);
app.use('/webhooks/whatsapp', whatsappRouter);
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
  console.log('');
  log('sistema', 'servidor iniciado');
});

process.on('unhandledRejection', (err) => log('sistema', `promessa rejeitada: ${err?.message ?? err}`));
