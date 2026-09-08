/**
 * Quem é o usuário desta requisição.
 *
 * Guardado em AsyncLocalStorage para que as camadas de baixo (banco, busca,
 * campanha) saibam de quem é o dado sem precisar receber o usuário como
 * parâmetro em toda função — o que exigiria mudar dezenas de assinaturas e
 * abriria espaço para esquecer uma e vazar dado de um cliente para outro.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

export const comUsuario = (usuario, fn) => als.run({ usuario }, fn);
export const usuarioAtual = () => als.getStore()?.usuario ?? null;
export const idDoUsuario = () => usuarioAtual()?.id ?? null;
export const ehAdmin = () => usuarioAtual()?.papel === 'admin';

/**
 * Trecho de SQL que limita a consulta ao dono do dado.
 * Admin enxerga tudo; usuário comum só o que é dele.
 */
export function filtroDoDono(coluna = 'user_id') {
  if (ehAdmin()) return { sql: '', params: [] };
  const id = idDoUsuario();
  if (!id) return { sql: ` AND ${coluna} IS NULL`, params: [] };
  return { sql: ` AND ${coluna} = ?`, params: [id] };
}
