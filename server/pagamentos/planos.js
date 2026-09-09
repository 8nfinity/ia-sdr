/**
 * Cota de uso por plano (Basic/Pro) e créditos extra avulsos.
 *
 * O ciclo NÃO precisa de cron para "resetar": a contagem sempre olha só para
 * o que aconteceu desde `periodo_inicio` (atualizado a cada renovação pelo
 * webhook do Mercado Pago), então quando o período vira, a contagem some
 * sozinha - é só uma consulta com data, igual o resto do sistema já faz
 * (ex: gasto_mes em db.js).
 */
import { config } from '../config.js';
import { one, update } from '../db.js';
import { buscarPorId } from '../usuarios.js';

export const PLANOS = config.planos;
export const CREDITOS = config.creditos;

/** Erro com um "código" que o front-end reconhece para oferecer a compra. */
function erroComCodigo(mensagem, dados) {
  const err = new Error(mensagem);
  err.dados = dados;
  return err;
}

export const erroSemPlano = () =>
  erroComCodigo('Sua assinatura não está ativa. Escolha um plano para continuar.', {
    codigo: 'sem_plano',
  });

export const erroLimitePlano = (tipo, extra = {}) =>
  erroComCodigo(
    tipo === 'buscas'
      ? 'Você usou todas as buscas do seu plano neste ciclo. Compre um pacote extra para continuar.'
      : 'Você usou todas as ligações do seu plano neste ciclo. Compre um pacote extra para continuar.',
    { codigo: 'limite_plano', tipo, ...extra }
  );

/**
 * Quantas buscas/ligações o usuário já fez desde o início do ciclo atual.
 * Planilha importada não conta como "busca" - não custa nada de IA, o cliente
 * só está subindo a lista de telefones dele.
 */
export function usoNoCiclo(userId, desde) {
  const buscas =
    one(
      "SELECT COUNT(*) n FROM searches WHERE user_id=? AND created_at>=? AND (source IS NULL OR source<>'planilha')",
      userId,
      desde
    )?.n ?? 0;
  const ligacoes = one('SELECT COUNT(*) n FROM calls WHERE user_id=? AND created_at>=?', userId, desde)?.n ?? 0;
  return { buscas, ligacoes };
}

/** Retrato completo do plano/cota de um usuário, pronto para o painel. */
export function fichaDoUsuario(userId) {
  const u = buscarPorId(userId);
  if (!u) return null;
  const plano = PLANOS[u.plano] ?? null;
  const desde = u.periodo_inicio || u.created_at;
  const uso = plano ? usoNoCiclo(u.id, desde) : { buscas: 0, ligacoes: 0 };
  return {
    plano: plano
      ? {
          id: plano.id,
          nome: plano.nome,
          precoCentavos: plano.precoCentavos,
          buscasMes: plano.buscasMes,
          ligacoesMes: plano.ligacoesMes,
        }
      : null,
    assinaturaStatus: u.assinatura_status,
    periodoInicio: u.periodo_inicio,
    periodoFim: u.periodo_fim,
    usoCiclo: uso,
    creditosBuscas: u.creditos_buscas ?? 0,
    creditosLigacoes: u.creditos_ligacoes ?? 0,
    buscasRestantes: plano ? Math.max(0, plano.buscasMes - uso.buscas) + (u.creditos_buscas ?? 0) : 0,
    ligacoesRestantes: plano ? Math.max(0, plano.ligacoesMes - uso.ligacoes) + (u.creditos_ligacoes ?? 0) : 0,
  };
}

/**
 * Confere (e, se precisar, consome 1 crédito extra) antes de criar UMA busca.
 * Chamado uma vez por clique em "Buscar" - o admin nunca é bloqueado.
 */
export function conferirCotaBusca(usuario) {
  if (!usuario || usuario.papel === 'admin') return;
  if (usuario.assinatura_status !== 'ativa') throw erroSemPlano();
  const plano = PLANOS[usuario.plano];
  if (!plano) throw erroSemPlano();

  const desde = usuario.periodo_inicio || usuario.created_at;
  const { buscas } = usoNoCiclo(usuario.id, desde);
  if (buscas < plano.buscasMes) return; // ainda dentro da cota do plano

  const creditos = usuario.creditos_buscas ?? 0;
  if (creditos <= 0) {
    throw erroLimitePlano('buscas', { restantes: 0, cota: plano.buscasMes });
  }
  update('usuarios', usuario.id, { creditos_buscas: creditos - 1 });
}

/**
 * Confere (e reserva créditos extra se precisar) antes de discar uma
 * campanha inteira de uma vez - uma campanha de N empresas consome N
 * "ligações" do total. Bloqueia a campanha INTEIRA se não houver cota
 * suficiente (nem no plano, nem em créditos), em vez de discar parte dela.
 */
export function conferirCotaLigacoes(usuario, quantidade) {
  if (!usuario || usuario.papel === 'admin') return;
  if (usuario.assinatura_status !== 'ativa') throw erroSemPlano();
  const plano = PLANOS[usuario.plano];
  if (!plano) throw erroSemPlano();

  const desde = usuario.periodo_inicio || usuario.created_at;
  const { ligacoes } = usoNoCiclo(usuario.id, desde);
  const restantesDoPlano = Math.max(0, plano.ligacoesMes - ligacoes);
  const faltam = Math.max(0, quantidade - restantesDoPlano);

  const creditos = usuario.creditos_ligacoes ?? 0;
  if (faltam > creditos) {
    throw erroLimitePlano('ligacoes', {
      restantes: restantesDoPlano + creditos,
      necessario: quantidade,
    });
  }
  if (faltam > 0) update('usuarios', usuario.id, { creditos_ligacoes: creditos - faltam });
}
