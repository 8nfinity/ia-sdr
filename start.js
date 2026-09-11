/**
 * Iniciador do IA SDR.
 * Confere tudo que costuma quebrar ANTES de subir o servidor e explica em
 * portugues o que fazer: versao do Node, dependencias, arquivo .env e porta.
 * Rode com: npm start
 */
import './server/certs.js'; // define SSL_CERT_FILE se o container nao tiver trust store
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const raiz = path.dirname(fileURLToPath(import.meta.url));
const linha = '  ' + '-'.repeat(62);

const erroFatal = (titulo, passos) => {
  console.error('\n  ' + '='.repeat(62));
  console.error('  ERRO: ' + titulo);
  console.error('  ' + '='.repeat(62));
  for (const p of passos) console.error('  ' + p);
  console.error('');
  process.exit(1);
};

// ─── 1. versao do Node ───────────────────────────────────────────────
const [maior, menor] = process.versions.node.split('.').map(Number);
if (maior < 22 || (maior === 22 && menor < 5)) {
  erroFatal(`Node ${process.versions.node} e antigo demais (precisa 22.5 ou mais novo).`, [
    'O sistema usa o banco SQLite que ja vem embutido no Node novo.',
    '',
    '1. Baixe o Node LTS em https://nodejs.org',
    '2. Instale, FECHE este terminal e abra um novo',
    '3. Confira com: node -v',
  ]);
}

// ─── 2. banco embutido disponivel ────────────────────────────────────
try {
  await import('node:sqlite');
} catch {
  erroFatal('Este Node nao tem o modulo node:sqlite.', [
    `Versao encontrada: ${process.versions.node}`,
    'Instale o Node LTS mais recente em https://nodejs.org e tente de novo.',
  ]);
}

// ─── 3. dependencias instaladas ──────────────────────────────────────
if (!fs.existsSync(path.join(raiz, 'node_modules', 'express'))) {
  console.log('\n  Dependencias ausentes. Instalando (pode levar 1 minuto)...\n');
  // Comando inteiro numa string: com shell + lista de argumentos o Node avisa
  // de risco de injecao, e no Windows o npm so existe como .cmd.
  const r = spawnSync('npm install --no-audit --no-fund', {
    cwd: raiz,
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0 || !fs.existsSync(path.join(raiz, 'node_modules', 'express'))) {
    erroFatal('Nao consegui instalar as dependencias.', [
      'Rode manualmente na pasta do projeto:',
      '',
      '   npm install',
      '',
      'Se der erro de rede/proxy, e ele que precisa ser resolvido primeiro.',
    ]);
  }
  console.log('\n  Dependencias instaladas.\n');
}

// ─── 4. arquivo .env ─────────────────────────────────────────────────
const envPath = path.join(raiz, '.env');
if (!fs.existsSync(envPath)) {
  const exemplo = path.join(raiz, '.env.example');
  if (fs.existsSync(exemplo)) {
    fs.copyFileSync(exemplo, envPath);
    console.log('  Criei o arquivo .env a partir do .env.example.');
  }
}

// ─── 5. porta livre ──────────────────────────────────────────────────
// Sonda a porta do MESMO jeito que o servidor vai abrir (sem host = IPv6 + IPv4).
// Sondar so o IPv4 daria "porta livre" com um servidor antigo ainda preso nela.
const portaLivre = (porta) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(porta);
  });

const desejada = Number(process.env.PORT) || 3000;
let porta = desejada;

// Numa hospedagem (Northflank, Render, Fly) a PORT vem definida pela
// plataforma, e ela vai procurar o app exatamente nela. Trocar de porta ali
// faria o servico subir num lugar onde ninguem olha e "falhar" sem erro.
// Trocar de porta so faz sentido no computador de casa.
const portaImposta = Boolean(process.env.PORT);
if (!portaImposta) {
  for (let i = 0; i < 20 && !(await portaLivre(porta)); i++) porta = desejada + i + 1;
}

if (porta !== desejada) {
  console.log(linha);
  console.log(`  A porta ${desejada} esta ocupada (outro programa ou um servidor`);
  console.log(`  antigo ainda rodando). Subindo na porta ${porta}.`);
  console.log(linha);
}
process.env.PORT = String(porta);

// ─── 6. tunel publico (para a Twilio alcancar este computador) ───────
// Sobe junto com o servidor: uma janela so, na ordem certa, sempre.
// Quem tem dominio proprio define PUBLIC_BASE_URL e TUNEL_AUTOMATICO=false.
const enderecoAtual = (process.env.PUBLIC_BASE_URL || '').trim();
const enderecoDescartavel = !enderecoAtual || enderecoAtual.includes('trycloudflare.com');
const querTunel = process.env.TUNEL_AUTOMATICO !== 'false' && enderecoDescartavel;

let atualizarEndereco = null;
if (querTunel) {
  console.log('  Abrindo o tunel publico...');
  try {
    const { iniciarTunel } = await import('./server/tunel.js');
    const url = await iniciarTunel({
      porta,
      aoMudarEndereco: (nova) => atualizarEndereco?.(nova),
    });
    process.env.PUBLIC_BASE_URL = url;
    gravarNoEnv('PUBLIC_BASE_URL', url); // para o "npm run checar" e os testes
    console.log(`  Endereco publico: ${url}\n`);
  } catch (err) {
    console.log(`  Tunel indisponivel (${err.message}).`);
    console.log('  O sistema sobe assim mesmo, mas as ligacoes ficam em modo simulacao.\n');
  }
}

/** Mantem o .env em dia com o endereco do tunel da vez. */
function gravarNoEnv(chave, valor) {
  try {
    let env = fs.readFileSync(envPath, 'utf8');
    env = new RegExp(`^${chave}=.*$`, 'm').test(env)
      ? env.replace(new RegExp(`^${chave}=.*$`, 'm'), `${chave}=${valor}`)
      : `${env}\n${chave}=${valor}\n`;
    fs.writeFileSync(envPath, env);
  } catch {
    /* .env somente leitura: o processo ja tem o valor na memoria */
  }
}

// ─── 7. restaura o banco de um backup remoto, se o container subiu vazio ──
// Precisa acontecer ANTES do server/index.js, que abre o arquivo do banco.
try {
  const { restaurarSePrecisar } = await import('./server/persistencia.js');
  await restaurarSePrecisar();
} catch (err) {
  console.error('  (persistencia) checagem de backup falhou: ' + (err?.message ?? err));
}

// ─── 8. sobe o servidor e abre o navegador no endereco certo ─────────
try {
  await import('./server/index.js');

  // Tunel reconectado com outro endereco: atualiza a config em memoria, senao
  // a Twilio continuaria mandando os eventos para o endereco antigo.
  const { config } = await import('./server/config.js');
  atualizarEndereco = (nova) => {
    config.publicBaseUrl = nova;
    gravarNoEnv('PUBLIC_BASE_URL', nova);
  };

  // Abrir o index.html com dois cliques nao funciona (sem servidor, sem API).
  // Entao o proprio iniciador abre a pagina certa. NAO_ABRIR=1 desliga isso.
  if (!process.env.NAO_ABRIR) {
    const url = `http://localhost:${porta}`;
    const cmd =
      process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    setTimeout(() => {
      try { spawnSync(cmd, { shell: true, stdio: 'ignore' }); } catch { /* abra na mao */ }
    }, 1200);
  }
} catch (err) {
  erroFatal('O servidor nao subiu.', [
    String(err?.message ?? err),
    '',
    'Se a mensagem falar em "Cannot find package", rode: npm install',
    'Qualquer outra coisa: copie o texto acima inteiro.',
  ]);
}
