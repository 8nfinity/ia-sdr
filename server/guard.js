/**
 * Autorização por dono do dado.
 *
 * Cada rota que recebe um id no caminho (/campaigns/:id, /companies/:id, ...)
 * PRECISA passar por aqui: sem isso, um cliente logado consegue ler/alterar o
 * lead, a ligação, a gravação ou a reunião de OUTRO cliente só trocando o id
 * na URL. Retorna 404 (não 403) de propósito - não confirma nem que o
 * registro existe.
 */
import { one } from './db.js';
import { ehAdmin, idDoUsuario } from './contexto.js';

export function meuOu404(row) {
  if (row && (ehAdmin() || row.user_id === idDoUsuario())) return row;
  const e = new Error('não encontrado');
  e.status = 404;
  throw e;
}

export const minhaEmpresa = (id) => meuOu404(one('SELECT * FROM companies WHERE id=?', id));
export const minhaBusca = (id) => meuOu404(one('SELECT * FROM searches WHERE id=?', id));
export const minhaCampanha = (id) => meuOu404(one('SELECT * FROM campaigns WHERE id=?', id));
export const minhaCall = (id) => meuOu404(one('SELECT * FROM calls WHERE id=?', id));
export const minhaReuniao = (id) => meuOu404(one('SELECT * FROM reunioes WHERE id=?', id));

/**
 * Só permite baixar/tocar gravação de URL da própria Twilio - senão a rota de
 * proxy viraria um SSRF (o servidor buscaria qualquer endereço interno que o
 * atacante colocasse no campo).
 */
export function urlDeGravacaoConfiavel(url) {
  return typeof url === 'string' && /^https:\/\/api\.twilio\.com\//.test(url);
}
