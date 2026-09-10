import { WebSocketServer } from 'ws';
import { usuarioDaRequisicao } from './auth.js';
import { idDoUsuario, ehAdmin } from './contexto.js';

let wss = null;

export function attachRealtime(server) {
  // O painel transmite nome de empresa, telefone e conversa: o socket precisa
  // da mesma sessao que o resto - e cada socket fica marcado com O DONO, para
  // um cliente nunca receber evento de outro.
  wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({ req }, done) => {
      const u = usuarioDaRequisicao(req);
      if (!u) return done(false, 401, 'sem sessao');
      req._userId = u.id;
      req._admin = u.papel === 'admin';
      done(true);
    },
  });
  wss.on('connection', (ws, req) => {
    ws._userId = req._userId;
    ws._admin = Boolean(req._admin);
    ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
  });
  wss.on('error', (err) => console.error('  (websocket) ' + err.message));
  return wss;
}

/**
 * Envia um evento SÓ para os paineis do dono do dado (e para admins).
 *
 * O dono vem de `opts.userId` quando dá para passar explicitamente (webhooks
 * da Twilio/Meta nao tem sessao), ou do contexto da requisicao. Sem nenhum
 * dono identificavel, o evento e tratado como "de sistema" e vai apenas para
 * os admins - nunca para um cliente qualquer.
 */
export function emit(type, payload = {}, opts = {}) {
  if (!wss) return;
  const dono = opts.userId ?? idDoUsuario() ?? null;
  const msg = JSON.stringify({ type, ...payload, ts: Date.now() });
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    const pode = client._admin || (dono && client._userId === dono);
    if (!pode) continue;
    try { client.send(msg); } catch { /* cliente caiu */ }
  }
}

export const log = (scope, message, extra = {}) => {
  const line = `[${scope}] ${message}`;
  console.log(line);
  // O console do servidor sempre recebe; o painel (WebSocket) so o dono/admins.
  emit('log', { scope, message, ...extra }, { userId: extra.userId });
};
