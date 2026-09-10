/**
 * Persistência do banco entre deploys.
 *
 * O problema: em hospedagem (Railway/Render/Fly) o container é DESCARTADO a
 * cada deploy. Se o iasdr.db estiver dentro do container, some tudo -
 * usuários, dados e o segredo de sessão (por isso todo mundo é deslogado).
 *
 * Duas camadas de proteção:
 *   1. Volume persistente montado em DATA_DIR (config na hospedagem). O
 *      diagnóstico abaixo avisa em letras garrafais se NÃO estiver num volume.
 *   2. Backup automático para um bucket S3/R2 (opcional, via env). Sobe uma
 *      cópia a cada X minutos E no encerramento (a hospedagem manda SIGTERM
 *      antes de trocar o container - dá tempo de salvar). Se o container subir
 *      com o banco VAZIO e existir backup remoto, restaura sozinho no boot.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AwsClient } from 'aws4fetch';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(aqui, '..', 'data');
export const caminhoBanco = path.join(dataDir, 'iasdr.db');

const cfg = {
  endpoint: (process.env.BACKUP_S3_ENDPOINT || '').replace(/\/+$/, ''),
  bucket: process.env.BACKUP_S3_BUCKET || '',
  keyId: process.env.BACKUP_S3_KEY_ID || '',
  secret: process.env.BACKUP_S3_SECRET || '',
  region: process.env.BACKUP_S3_REGION || 'auto',
  intervaloMin: Number(process.env.BACKUP_INTERVALO_MIN) || 30,
  manter: Number(process.env.BACKUP_MANTER) || 48,
};

export const backupRemotoAtivo = () =>
  Boolean(cfg.endpoint && cfg.bucket && cfg.keyId && cfg.secret);

function cliente() {
  return new AwsClient({
    accessKeyId: cfg.keyId,
    secretAccessKey: cfg.secret,
    region: cfg.region,
    service: 's3',
  });
}
const urlObjeto = (key) => `${cfg.endpoint}/${cfg.bucket}/${key.replace(/^\/+/, '')}`;
const PREFIXO = 'backups/';

async function enviarObjeto(key, buffer) {
  const res = await cliente().fetch(urlObjeto(key), {
    method: 'PUT',
    body: buffer,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buffer.length) },
  });
  if (!res.ok) throw new Error(`S3 PUT ${key}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
}

async function baixarObjeto(key) {
  const res = await cliente().fetch(urlObjeto(key));
  if (!res.ok) throw new Error(`S3 GET ${key}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function apagarObjeto(key) {
  await cliente().fetch(urlObjeto(key), { method: 'DELETE' }).catch(() => {});
}

/** Lista os backups (mais novo primeiro). */
async function listarBackups() {
  const url = `${cfg.endpoint}/${cfg.bucket}?list-type=2&prefix=${encodeURIComponent(PREFIXO)}`;
  const res = await cliente().fetch(url);
  if (!res.ok) throw new Error(`S3 LIST: HTTP ${res.status}`);
  const xml = await res.text();
  const itens = [];
  const re = /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<LastModified>([^<]+)<\/LastModified>[\s\S]*?<\/Contents>/g;
  let m;
  while ((m = re.exec(xml))) itens.push({ key: m[1], quando: m[2] });
  return itens.filter((i) => /\.db$/.test(i.key)).sort((a, b) => (a.quando < b.quando ? 1 : -1));
}

/** true se o banco local tem pelo menos 1 usuário (ou seja, não está vazio). */
function bancoTemUsuarios() {
  if (!fs.existsSync(caminhoBanco) || fs.statSync(caminhoBanco).size < 4096) return false;
  try {
    const db = new DatabaseSync(caminhoBanco, { readOnly: true });
    const n = db.prepare('SELECT COUNT(*) n FROM usuarios').get()?.n ?? 0;
    db.close();
    return n > 0;
  } catch {
    return false; // tabela ainda não existe = vazio
  }
}

/** No boot: se o banco local está vazio e há backup remoto, restaura. */
export async function restaurarSePrecisar() {
  if (!backupRemotoAtivo()) return;
  if (bancoTemUsuarios()) return; // banco vivo, não mexe

  try {
    const backups = await listarBackups();
    if (!backups.length) {
      console.log('  [persistencia] banco local vazio e nenhum backup remoto ainda - começando do zero.');
      return;
    }
    const alvo = backups[0];
    console.log(`  [persistencia] banco local vazio. Restaurando backup remoto: ${alvo.key} (${alvo.quando})`);
    const buffer = await baixarObjeto(alvo.key);
    if (buffer.subarray(0, 15).toString('latin1') !== 'SQLite format 3') {
      throw new Error('o arquivo baixado não é um SQLite válido');
    }
    fs.mkdirSync(dataDir, { recursive: true });
    for (const s of ['-wal', '-shm']) { try { fs.rmSync(caminhoBanco + s); } catch { /* ok */ } }
    fs.writeFileSync(caminhoBanco, buffer);
    console.log(`  [persistencia] restaurado (${(buffer.length / 1024).toFixed(0)} KB). Nenhum dado perdido.`);
  } catch (err) {
    console.error(`  [persistencia] NÃO consegui restaurar o backup remoto: ${err.message}`);
    console.error('  [persistencia] o sistema sobe com o banco atual - confira o backup ANTES de os clientes usarem.');
  }
}

let enviando = false;

/** Sobe uma cópia do banco (buffer já com checkpoint feito) para o bucket. */
export async function enviarBackup(buffer, motivo = 'periodico') {
  if (!backupRemotoAtivo() || enviando) return;
  enviando = true;
  try {
    const nome = `${PREFIXO}iasdr-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    await enviarObjeto(nome, buffer);
    console.log(`  [persistencia] backup remoto enviado (${motivo}, ${(buffer.length / 1024).toFixed(0)} KB).`);
    // Poda: mantém só os N mais novos.
    const backups = await listarBackups().catch(() => []);
    for (const velho of backups.slice(cfg.manter)) await apagarObjeto(velho.key);
  } catch (err) {
    console.error(`  [persistencia] falha ao enviar backup remoto: ${err.message}`);
  } finally {
    enviando = false;
  }
}

export const intervaloBackupMs = () => Math.max(5, cfg.intervaloMin) * 60000;

/** Para o painel do admin: o backup remoto está ligado e quando foi o último. */
export async function statusBackup() {
  if (!backupRemotoAtivo()) return { ativo: false, ultimo: null, intervaloMin: cfg.intervaloMin };
  try {
    const backups = await listarBackups();
    return { ativo: true, ultimo: backups[0]?.quando ?? null, total: backups.length, intervaloMin: cfg.intervaloMin };
  } catch (err) {
    return { ativo: true, ultimo: null, erro: err.message, intervaloMin: cfg.intervaloMin };
  }
}

/**
 * Diz, no boot, se os dados estão num lugar que SOBREVIVE ao próximo deploy.
 * Só faz barulho quando DATA_DIR foi configurado (sinal de que é hospedagem).
 */
export function diagnosticoPersistencia() {
  if (backupRemotoAtivo()) {
    console.log(`  [persistencia] backup remoto ATIVO (a cada ${cfg.intervaloMin} min + no encerramento).`);
  }
  // Só interessa em container Linux de hospedagem com DATA_DIR configurado.
  if (!process.env.DATA_DIR || process.platform !== 'linux') return;

  let volume = null;
  try {
    volume = fs.statSync(dataDir).dev !== fs.statSync('/').dev;
  } catch { /* não deu pra checar */ }

  if (volume === true) {
    console.log(`  [persistencia] DATA_DIR está num volume persistente (${dataDir}) - dados sobrevivem ao deploy.`);
  } else if (volume === false) {
    console.error('');
    console.error('  ##################################################################');
    console.error('  #  ATENCAO: os dados NAO estao num volume persistente!            #');
    console.error(`  #  DATA_DIR = ${dataDir}`);
    console.error('  #  Tudo (usuarios, leads, sessoes) sera APAGADO no proximo deploy.#');
    console.error('  #                                                                #');
    console.error('  #  Railway: Settings > Volumes > New Volume                       #');
    console.error('  #           Mount path:  /app/data                               #');
    console.error('  #  E confirme DATA_DIR=/app/data nas Variables.                   #');
    console.error('  #                                                                #');
    console.error('  #  (Se BACKUP_S3_* estiver configurado, o backup remoto ainda    #');
    console.error('  #   te protege - mas o volume e o certo.)                         #');
    console.error('  ##################################################################');
    console.error('');
  }
}
