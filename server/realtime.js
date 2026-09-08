import { WebSocketServer } from 'ws';
import { temSessao } from './auth.js';

let wss = null;

export function attachRealtime(server) {
  // O painel transmite nome de empresa, telefone e conversa: o socket precisa
  // da mesma sessao que o resto.
  wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => temSessao(req) });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
  });
  // O ws repassa erros do servidor HTTP para o WebSocketServer. Sem um ouvinte
  // aqui, um EADDRINUSE virava "Unhandled 'error' event" e o servidor morria
  // antes de conseguir mostrar a mensagem explicando a porta ocupada.
  wss.on('error', (err) => console.error('  (websocket) ' + err.message));
  return wss;
}

/** Envia um evento para todos os paineis abertos. */
export function emit(type, payload = {}) {
  const msg = JSON.stringify({ type, ...payload, ts: Date.now() });
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try { client.send(msg); } catch { /* cliente caiu */ }
    }
  }
}

export const log = (scope, message, extra = {}) => {
  const line = `[${scope}] ${message}`;
  console.log(line);
  emit('log', { scope, message, ...extra });
};
