/**
 * Leitura de planilhas (.xlsx, .csv) sem dependência externa.
 *
 * Um .xlsx é um ZIP com XML dentro. Em vez de instalar uma biblioteca inteira
 * (e carregar as vulnerabilidades dela) para ler duas colunas, o módulo abre o
 * ZIP com o zlib do próprio Node e lê o XML das células.
 *
 * O objetivo é modesto de propósito: achar NOME e TELEFONE em qualquer
 * planilha que o usuário tenha, sem exigir formato específico.
 */
import zlib from 'node:zlib';
import { toE164BR, isPlausiblePhone } from '../util.js';

// ─────────────────────────── ZIP (só o que o xlsx usa) ───────────────────────
/**
 * Extrai um arquivo de dentro do ZIP pelo nome.
 * Lê o "end of central directory" e caminha pelas entradas — é o mínimo para
 * pegar sharedStrings.xml e a primeira planilha.
 */
function extrairDoZip(buffer, alvo) {
  // Assinatura do fim do diretório central: PK\005\006
  let fim = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      fim = i;
      break;
    }
  }
  if (fim === -1) return null;

  const total = buffer.readUInt16LE(fim + 10);
  let ponteiro = buffer.readUInt32LE(fim + 16);

  for (let n = 0; n < total; n++) {
    if (buffer.readUInt32LE(ponteiro) !== 0x02014b50) return null; // PK\001\002
    const compressao = buffer.readUInt16LE(ponteiro + 10);
    const tamComprimido = buffer.readUInt32LE(ponteiro + 20);
    const tamNome = buffer.readUInt16LE(ponteiro + 28);
    const tamExtra = buffer.readUInt16LE(ponteiro + 30);
    const tamComentario = buffer.readUInt16LE(ponteiro + 32);
    const inicioLocal = buffer.readUInt32LE(ponteiro + 42);
    const nome = buffer.toString('utf8', ponteiro + 46, ponteiro + 46 + tamNome);

    if (nome === alvo || nome.endsWith('/' + alvo)) {
      // No cabeçalho local os tamanhos de nome/extra podem diferir: releia.
      const nomeLocal = buffer.readUInt16LE(inicioLocal + 26);
      const extraLocal = buffer.readUInt16LE(inicioLocal + 28);
      const inicioDados = inicioLocal + 30 + nomeLocal + extraLocal;
      const dados = buffer.subarray(inicioDados, inicioDados + tamComprimido);
      // maxOutputLength trava "zip bomb": um .xlsx minusculo cujo XML interno
      // descomprime para gigabytes e derruba o processo por falta de memoria.
      return compressao === 0
        ? dados
        : zlib.inflateRawSync(dados, { maxOutputLength: 80 * 1024 * 1024 });
    }
    ponteiro += 46 + tamNome + tamExtra + tamComentario;
  }
  return null;
}

const semTags = (xml) =>
  xml
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();

/** Converte a referência da célula (B7) no índice da coluna (1). */
const colunaDe = (ref) => {
  const letras = String(ref ?? '').match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const c of letras) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
};

/** Lê um .xlsx e devolve uma matriz de linhas com textos. */
function lerXlsx(buffer) {
  const compartilhadas = [];
  const ss = extrairDoZip(buffer, 'xl/sharedStrings.xml');
  if (ss) {
    for (const m of ss.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      compartilhadas.push(semTags(m[1]));
    }
  }

  const folha = extrairDoZip(buffer, 'xl/worksheets/sheet1.xml');
  if (!folha) throw new Error('nao consegui ler a primeira aba da planilha');

  const linhas = [];
  for (const linha of folha.toString('utf8').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const celulas = [];
    for (const cel of linha[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cel[1];
      const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1];
      const tipo = attrs.match(/t="([^"]+)"/)?.[1];
      const bruto = cel[2];

      let valor;
      if (tipo === 's') {
        valor = compartilhadas[Number(semTags(bruto))] ?? '';
      } else if (tipo === 'inlineStr') {
        valor = semTags(bruto);
      } else {
        valor = semTags(bruto);
      }
      celulas[colunaDe(ref)] = valor;
    }
    // Célula vazia vira string vazia para não desalinhar as colunas.
    linhas.push(Array.from(celulas, (c) => c ?? ''));
  }
  return linhas;
}

// ─────────────────────────────────── CSV ─────────────────────────────────────
/** CSV/TSV com aspas, vírgula ou ponto e vírgula (o padrão do Excel brasileiro). */
function lerCsv(texto) {
  const limpo = texto.replace(/^﻿/, '');
  const primeira = limpo.split(/\r?\n/)[0] ?? '';
  const sep = [';', '\t', ',']
    .map((s) => ({ s, n: primeira.split(s).length }))
    .sort((a, b) => b.n - a.n)[0].s;

  const linhas = [];
  let campo = '';
  let linha = [];
  let entreAspas = false;

  for (let i = 0; i < limpo.length; i++) {
    const c = limpo[i];
    if (entreAspas) {
      if (c === '"' && limpo[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') entreAspas = false;
      else campo += c;
      continue;
    }
    if (c === '"') entreAspas = true;
    else if (c === sep) { linha.push(campo); campo = ''; }
    else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas.map((l) => l.map((v) => v.trim()));
}

// ────────────────────────── identificação das colunas ────────────────────────
const PISTAS_NOME = ['nome', 'empresa', 'razao', 'razão', 'cliente', 'contato', 'fantasia', 'estabelecimento'];
const PISTAS_TEL = ['telefone', 'fone', 'celular', 'whatsapp', 'whats', 'tel', 'contato', 'numero', 'número'];
const PISTAS_EXTRA = { email: ['email', 'e-mail'], site: ['site', 'website', 'url'], instagram: ['instagram', 'insta', '@'] };

const normalizar = (s) =>
  String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

const pareceTelefone = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 && d.length <= 13;
};

/**
 * Descobre qual coluna é o quê.
 * Primeiro tenta pelo cabeçalho; se a planilha não tiver cabeçalho, olha o
 * conteúdo: a coluna com mais telefones válidos é o telefone, e a coluna de
 * texto mais longa é o nome.
 */
function mapearColunas(linhas) {
  const cabecalho = linhas[0] ?? [];
  const temCabecalho = cabecalho.some((c) => {
    const n = normalizar(c);
    return [...PISTAS_NOME, ...PISTAS_TEL].some((p) => n.includes(p));
  });

  const mapa = { nome: -1, telefone: -1, email: -1, site: -1, instagram: -1 };

  if (temCabecalho) {
    cabecalho.forEach((celula, i) => {
      const n = normalizar(celula);
      if (mapa.telefone === -1 && PISTAS_TEL.some((p) => n.includes(p))) mapa.telefone = i;
      if (mapa.nome === -1 && PISTAS_NOME.some((p) => n.includes(p))) mapa.nome = i;
      for (const [campo, pistas] of Object.entries(PISTAS_EXTRA)) {
        if (mapa[campo] === -1 && pistas.some((p) => n.includes(p))) mapa[campo] = i;
      }
    });
    // "Contato" pode ser nome ou telefone: se virou os dois, desempata.
    if (mapa.nome === mapa.telefone && mapa.nome !== -1) mapa.nome = -1;
  }

  const corpo = temCabecalho ? linhas.slice(1) : linhas;

  if (mapa.telefone === -1) {
    const placar = [];
    for (const linha of corpo.slice(0, 40)) {
      linha.forEach((v, i) => {
        if (pareceTelefone(v)) placar[i] = (placar[i] ?? 0) + 1;
      });
    }
    const melhor = placar.reduce((a, v, i) => (v > (placar[a] ?? 0) ? i : a), 0);
    if ((placar[melhor] ?? 0) > 0) mapa.telefone = melhor;
  }

  if (mapa.nome === -1) {
    const tamanho = [];
    for (const linha of corpo.slice(0, 40)) {
      linha.forEach((v, i) => {
        if (i === mapa.telefone || pareceTelefone(v)) return;
        tamanho[i] = (tamanho[i] ?? 0) + String(v ?? '').length;
      });
    }
    const melhor = tamanho.reduce((a, v, i) => (v > (tamanho[a] ?? 0) ? i : a), 0);
    if ((tamanho[melhor] ?? 0) > 0) mapa.nome = melhor;
  }

  return { mapa, temCabecalho, cabecalho };
}

/**
 * Lê a planilha inteira e devolve os contatos prontos para ligar.
 * Nada é descartado em silêncio: quem ficou de fora vem em `ignorados`.
 */
export function lerPlanilha(buffer, nomeArquivo = '') {
  const ehExcel =
    /\.xlsx?$/i.test(nomeArquivo) || (buffer[0] === 0x50 && buffer[1] === 0x4b); // "PK"

  if (/\.xls$/i.test(nomeArquivo) && !ehExcel) {
    throw new Error('Formato .xls antigo nao suportado. Salve como .xlsx ou .csv no Excel.');
  }

  const linhas = ehExcel ? lerXlsx(buffer) : lerCsv(buffer.toString('utf8'));
  if (!linhas.length) throw new Error('A planilha esta vazia.');

  const { mapa, temCabecalho, cabecalho } = mapearColunas(linhas);
  if (mapa.telefone === -1) {
    throw new Error('Nao encontrei nenhuma coluna com telefone. Confira se a planilha tem os numeros.');
  }

  const corpo = temCabecalho ? linhas.slice(1) : linhas;
  const contatos = [];
  const ignorados = [];
  const vistos = new Set();

  for (const linha of corpo) {
    if (!linha.some((c) => String(c ?? '').trim())) continue; // linha em branco

    const bruto = linha[mapa.telefone];
    const nome = String(linha[mapa.nome] ?? '').trim();
    const telefone = toE164BR(bruto);

    if (!telefone || !isPlausiblePhone(telefone)) {
      ignorados.push({ nome: nome || '(sem nome)', telefone: String(bruto ?? '').trim(), motivo: 'telefone invalido' });
      continue;
    }
    if (vistos.has(telefone)) {
      ignorados.push({ nome: nome || '(sem nome)', telefone, motivo: 'repetido na planilha' });
      continue;
    }
    vistos.add(telefone);

    contatos.push({
      name: nome || telefone,
      phone: String(bruto ?? '').trim(),
      phoneE164: telefone,
      email: mapa.email > -1 ? String(linha[mapa.email] ?? '').trim() || null : null,
      website: mapa.site > -1 ? String(linha[mapa.site] ?? '').trim() || null : null,
      instagram: mapa.instagram > -1 ? String(linha[mapa.instagram] ?? '').trim() || null : null,
    });
  }

  return {
    contatos,
    ignorados,
    colunas: {
      nome: mapa.nome > -1 ? cabecalho[mapa.nome] || `coluna ${mapa.nome + 1}` : '(nenhuma)',
      telefone: cabecalho[mapa.telefone] || `coluna ${mapa.telefone + 1}`,
    },
    total: corpo.length,
  };
}
