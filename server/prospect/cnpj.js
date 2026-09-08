/**
 * Dados públicos da Receita Federal — de graça e sem gastar um token de IA.
 *
 * Traz o que mais importa na prospecção: nome dos SÓCIOS (o decisor), telefone
 * e e-mail registrados no CNPJ, e a situação cadastral — que descarta empresa
 * baixada antes de você gastar uma ligação com ela.
 *
 * O CNPJ vem do rodapé do site da empresa (quase todo site brasileiro tem) ou
 * do que a IA já viu na busca. Nenhuma consulta paga é feita por isso.
 *
 * As três APIs públicas limitam ~3 consultas por minuto cada. Por isso o
 * módulo reveza entre elas e coloca quem falhar de castigo por um tempo.
 */
import { fetchWithTimeout } from '../util.js';
import { log } from '../realtime.js';

const RE_CNPJ = /\b(\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2})\b/g;

/** Valida os dígitos verificadores: evita consultar número inventado. */
export function cnpjValido(valor) {
  const c = String(valor ?? '').replace(/\D/g, '');
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const digito = (base) => {
    let peso = base.length === 12 ? 5 : 6;
    let soma = 0;
    for (const n of base) {
      soma += Number(n) * peso;
      peso = peso === 2 ? 9 : peso - 1;
    }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const base = c.slice(0, 12);
  return Number(c[12]) === digito(base) && Number(c[13]) === digito(base + c[12]);
}

/** Acha o primeiro CNPJ válido dentro de um HTML (rodapé, página de contato). */
export function extrairCnpj(html) {
  if (!html) return null;
  for (const m of String(html).matchAll(RE_CNPJ)) {
    const limpo = m[1].replace(/\D/g, '');
    if (cnpjValido(limpo)) return limpo;
  }
  return null;
}

const telefone = (t) => {
  const n = String(t ?? '').replace(/\D/g, '');
  return n.length >= 10 && n.length <= 11 ? n : null;
};

const montar = ({ cnpj, razao, fantasia, situacao, abertura, porte, tel1, tel2, email, socios, natureza, mei }) => {
  const lista = (socios ?? []).filter((s) => s.nome).slice(0, 5);
  return {
    cnpj,
    razaoSocial: razao ?? null,
    nomeFantasia: fantasia || null,
    situacao: situacao ?? null,
    ativa: /ATIVA/i.test(situacao ?? ''),
    abertura: abertura ?? null,
    porte: porte ?? null,
    telefoneReceita: telefone(tel1),
    telefoneReceita2: telefone(tel2),
    emailReceita: email || null,
    porteMenor: /MICRO|PEQUENO|ME|EPP/i.test(porte ?? '') || Boolean(mei),
    // Empresario Individual (213-5) e MEI: o CNPJ e praticamente a pessoa.
    empresarioIndividual: String(natureza ?? '').startsWith('213') || Boolean(mei),
    mei: Boolean(mei),
    socios: lista,
    // Quem manda: prioriza administrador/titular, senão o primeiro da lista.
    decisor:
      lista.find((s) => /administrador|titular|presidente|diretor/i.test(s.cargo ?? ''))?.nome ??
      lista[0]?.nome ??
      null,
  };
};

// Três fontes públicas do mesmo dado da Receita. Formatos diferentes.
const FONTES = [
  {
    nome: 'brasilapi',
    url: (c) => `https://brasilapi.com.br/api/cnpj/v1/${c}`,
    ler: (d, c) =>
      montar({
        cnpj: c,
        razao: d.razao_social,
        fantasia: d.nome_fantasia,
        situacao: d.descricao_situacao_cadastral,
        abertura: d.data_inicio_atividade,
        porte: d.porte,
        tel1: d.ddd_telefone_1,
        tel2: d.ddd_telefone_2,
        email: d.email,
        socios: (d.qsa ?? []).map((s) => ({ nome: s.nome_socio, cargo: s.qualificacao_socio })),
        natureza: d.codigo_natureza_juridica,
        mei: d.opcao_pelo_mei,
      }),
  },
  {
    nome: 'minhareceita',
    url: (c) => `https://minhareceita.org/${c}`,
    ler: (d, c) =>
      montar({
        cnpj: c,
        razao: d.razao_social,
        fantasia: d.nome_fantasia,
        situacao: d.descricao_situacao_cadastral,
        abertura: d.data_inicio_atividade,
        porte: d.porte,
        tel1: (d.ddd_telefone_1 ?? '').replace(/\s/g, ''),
        tel2: (d.ddd_telefone_2 ?? '').replace(/\s/g, ''),
        email: d.email,
        socios: (d.qsa ?? []).map((s) => ({ nome: s.nome_socio, cargo: s.qualificacao_socio })),
        natureza: d.codigo_natureza_juridica,
        mei: d.opcao_pelo_mei,
      }),
  },
  {
    nome: 'receitaws',
    url: (c) => `https://receitaws.com.br/v1/cnpj/${c}`,
    ler: (d, c) =>
      montar({
        cnpj: c,
        razao: d.nome,
        fantasia: d.fantasia,
        situacao: d.situacao,
        abertura: d.abertura,
        porte: d.porte,
        tel1: (d.telefone ?? '').split('/')[0],
        tel2: (d.telefone ?? '').split('/')[1],
        email: d.email,
        socios: (d.qsa ?? []).map((s) => ({ nome: s.nome, cargo: s.qual })),
      }),
  },
];

const castigo = new Map(); // fonte -> timestamp ate quando ignorar
const cache = new Map();

/**
 * Consulta o CNPJ revezando entre as fontes. Devolve null se todas falharem:
 * o dado da Receita e um bonus, nunca um requisito para a empresa entrar.
 */
export async function consultarCnpj(cnpj) {
  const limpo = String(cnpj ?? '').replace(/\D/g, '');
  if (!cnpjValido(limpo)) return null;
  if (cache.has(limpo)) return cache.get(limpo);

  const agora = Date.now();
  const disponiveis = FONTES.filter((f) => (castigo.get(f.nome) ?? 0) < agora);
  for (const fonte of disponiveis.length ? disponiveis : FONTES) {
    try {
      const res = await fetchWithTimeout(fonte.url(limpo), { headers: { Accept: 'application/json' } }, 15000);
      if (res.status === 429) {
        castigo.set(fonte.nome, Date.now() + 60000); // limite por minuto
        continue;
      }
      if (!res.ok) continue;
      const info = fonte.ler(await res.json(), limpo);
      if (!info.razaoSocial) continue;
      cache.set(limpo, info);
      return info;
    } catch {
      castigo.set(fonte.nome, Date.now() + 30000);
    }
  }

  log('cnpj', `nenhuma fonte respondeu para ${limpo}`);
  cache.set(limpo, null);
  return null;
}
