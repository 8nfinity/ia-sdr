/**
 * Rate limit simples, em memória (janela deslizante por chave).
 *
 * Reinicia junto com o processo - suficiente contra abuso automatizado; para
 * algo distribuído de verdade seria preciso um Redis. Limpa as chaves velhas
 * de tempos em tempos para a memória não crescer sem limite.
 */
const baldes = new Map();

setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of baldes) if (v.reset < agora) baldes.delete(k);
}, 300000).unref?.();

/**
 * Conta 1 acesso para `chave`. Retorna { ok, retryS }.
 * ok=false quando passou de `max` dentro de `janelaMs`.
 */
export function limitar(chave, max, janelaMs) {
  const agora = Date.now();
  let b = baldes.get(chave);
  if (!b || b.reset < agora) {
    b = { count: 0, reset: agora + janelaMs };
    baldes.set(chave, b);
  }
  b.count++;
  return { ok: b.count <= max, retryS: Math.ceil((b.reset - agora) / 1000) };
}

/** Zera o contador de uma chave (ex: login bem-sucedido). */
export const zerar = (chave) => baldes.delete(chave);

/** Middleware de rate limit por IP para um grupo de rotas. */
export function limitePorIp({ max, janelaMs, nome }) {
  return (req, res, next) => {
    const { ok, retryS } = limitar(`${nome}:${req.ip}`, max, janelaMs);
    if (ok) return next();
    res.set('Retry-After', String(retryS));
    res.status(429).json({ error: `Muitas requisições. Tente de novo em ${retryS}s.` });
  };
}
