/** Testa a leitura de planilhas: .csv e .xlsx de verdade, com casos chatos. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { lerPlanilha } from '../server/prospect/planilha.js';

const tmp = process.env.TEMP || '/tmp';
let falhas = 0;
const checar = (nome, ok, detalhe = '') => {
  console.log(`  ${ok ? 'OK  ' : 'FALHOU'} ${nome}${detalhe ? ' — ' + detalhe : ''}`);
  if (!ok) falhas++;
};

// ─── 1. CSV com ponto e vírgula (padrão do Excel brasileiro) ───
const csv = [
  'Nome;Telefone;Email',
  'Padaria do Zé;(51) 3224-0169;ze@padaria.com',
  'Mercado Silva;51 99876-5432;',
  'Sem telefone;;vazio@x.com',
  'Repetido;5132240169;',
  'Bar do João;+55 51 3308-7777;joao@bar.com',
].join('\n');
const r1 = lerPlanilha(Buffer.from(csv, 'utf8'), 'lista.csv');
checar('CSV ponto e vírgula', r1.contatos.length === 3, `${r1.contatos.length} contatos`);
checar('nome preservado', r1.contatos[0].name === 'Padaria do Zé', r1.contatos[0].name);
checar('telefone normalizado', r1.contatos[0].phoneE164 === '+555132240169', r1.contatos[0].phoneE164);
checar('celular lido', r1.contatos[1].phoneE164 === '+5551998765432', r1.contatos[1].phoneE164);
checar('sem telefone ignorado', r1.ignorados.some((i) => i.motivo === 'telefone invalido'));
checar('repetido ignorado', r1.ignorados.some((i) => i.motivo === 'repetido na planilha'));
checar('e-mail capturado', r1.contatos[0].email === 'ze@padaria.com');

// ─── 2. CSV com vírgula, aspas e sem cabeçalho ───
const csv2 = '"Restaurante, o bom",5133334444\n"Loja X",51988887777';
const r2 = lerPlanilha(Buffer.from(csv2, 'utf8'), 'sem-cabecalho.csv');
checar('sem cabeçalho', r2.contatos.length === 2, `${r2.contatos.length} contatos`);
checar('vírgula dentro de aspas', r2.contatos[0].name === 'Restaurante, o bom', r2.contatos[0].name);

// ─── 3. XLSX de verdade (montado como ZIP na mão) ───
function criarXlsx(destino) {
  const compartilhadas = ['Nome', 'Telefone', 'Clínica Alfa', 'Studio Beta'];
  const ss =
    '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">' +
    compartilhadas.map((s) => `<si><t>${s}</t></si>`).join('') +
    '</sst>';
  const sheet =
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>5133445566</v></c></row>' +
    '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>51997776666</v></c></row>' +
    '</sheetData></worksheet>';

  // ZIP mínimo, sem compressão (método 0).
  const arquivos = [
    { nome: 'xl/sharedStrings.xml', dados: Buffer.from(ss, 'utf8') },
    { nome: 'xl/worksheets/sheet1.xml', dados: Buffer.from(sheet, 'utf8') },
  ];
  const locais = [];
  const partes = [];
  let offset = 0;
  for (const a of arquivos) {
    const nome = Buffer.from(a.nome, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(a.dados) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // sem compressão
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(a.dados.length, 18);
    local.writeUInt32LE(a.dados.length, 22);
    local.writeUInt16LE(nome.length, 26);
    partes.push(local, nome, a.dados);
    locais.push({ nome, crc, tam: a.dados.length, offset });
    offset += 30 + nome.length + a.dados.length;
  }
  const inicioCentral = offset;
  for (const l of locais) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0, 10);
    c.writeUInt32LE(l.crc, 16);
    c.writeUInt32LE(l.tam, 20);
    c.writeUInt32LE(l.tam, 24);
    c.writeUInt16LE(l.nome.length, 28);
    c.writeUInt32LE(l.offset, 42);
    partes.push(c, l.nome);
    offset += 46 + l.nome.length;
  }
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(locais.length, 8);
  fim.writeUInt16LE(locais.length, 10);
  fim.writeUInt32LE(offset - inicioCentral, 12);
  fim.writeUInt32LE(inicioCentral, 16);
  partes.push(fim);

  fs.writeFileSync(destino, Buffer.concat(partes));
}

const caminho = path.join(tmp, 'teste-iasdr.xlsx');
criarXlsx(caminho);
const r3 = lerPlanilha(fs.readFileSync(caminho), 'planilha.xlsx');
checar('XLSX lido', r3.contatos.length === 2, `${r3.contatos.length} contatos`);
checar('nome do XLSX', r3.contatos[0].name === 'Clínica Alfa', r3.contatos[0].name);
checar('telefone do XLSX', r3.contatos[0].phoneE164 === '+555133445566', r3.contatos[0].phoneE164);
checar('celular do XLSX', r3.contatos[1].phoneE164 === '+5551997776666', r3.contatos[1].phoneE164);
fs.unlinkSync(caminho);

console.log(falhas ? `\n  ${falhas} teste(s) falharam\n` : '\n  Todos os testes passaram\n');
process.exit(falhas ? 1 : 0);
