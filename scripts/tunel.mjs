/**
 * Túnel do Cloudflare: expõe o servidor local na internet com HTTPS, de graça.
 *
 * Serve para a Twilio conseguir entregar os eventos das ligações sem você
 * precisar de servidor hospedado. O endereço muda a cada execução, então o
 * script atualiza o PUBLIC_BASE_URL do .env sozinho.
 *
 * Uso:  npm run tunel     (deixe rodando numa janela; o servidor em outra)
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(raiz, '.env');
const porta = process.env.PORT || 3000;

const instalar = () => {
  console.error('\n  Nao consegui usar o cloudflared.\n');
  console.error('  Windows:  baixe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe');
  console.error('            e salve como bin\\cloudflared.exe dentro da pasta do projeto');
  console.error('  Mac:      brew install cloudflared');
  console.error('  Linux:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n');
  process.exit(1);
};

/**
 * Baixa o cloudflared para dentro do projeto (pasta bin/).
 * Sem instalador, sem admin, sem mexer no PATH do Windows: se um dia quiser
 * remover, e so apagar a pasta.
 */
async function baixarCloudflared() {
  const arquivos = {
    win32: { url: 'cloudflared-windows-amd64.exe', nome: 'cloudflared.exe' },
    darwin: { url: 'cloudflared-darwin-amd64.tgz', nome: 'cloudflared' },
    linux: { url: 'cloudflared-linux-amd64', nome: 'cloudflared' },
  };
  const alvo = arquivos[process.platform];
  if (!alvo || process.platform === 'darwin') return null; // no Mac, use o brew

  const destino = path.join(raiz, 'bin', alvo.nome);
  if (fs.existsSync(destino)) return destino;

  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${alvo.url}`;
  console.log('  Baixando o cloudflared (uma vez so, ~50 MB)...');
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    fs.mkdirSync(path.join(raiz, 'bin'), { recursive: true });
    fs.writeFileSync(destino, Buffer.from(await res.arrayBuffer()));
    if (process.platform !== 'win32') fs.chmodSync(destino, 0o755);
    console.log(`  Pronto: ${destino}\n`);
    return destino;
  } catch (err) {
    console.error(`  Download falhou: ${err.message}`);
    return null;
  }
}

/** Usa o cloudflared do sistema, se existir; senao o que baixamos. */
function jaTemNoSistema() {
  try {
    execSync('cloudflared --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const executavel = jaTemNoSistema() ? 'cloudflared' : (await baixarCloudflared()) ?? instalar();

console.log(`\n  Abrindo tunel para http://localhost:${porta} ...\n`);

const proc = spawn(executavel, ['tunnel', '--url', `http://localhost:${porta}`]);

let jaAvisou = false;
function tratar(texto) {
  process.stdout.write(texto.replace(/^/gm, '  '));

  // O endereco do tunel tem varias palavras separadas por hifen
  // (ex: roses-camera-acres-careful). Exigir 3+ palavras evita capturar o
  // "api.trycloudflare.com" que o proprio cloudflared usa por dentro - erro que
  // grava um endereco invalido no .env e derruba a ligacao no "alo".
  const url = texto.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+){2,}\.trycloudflare\.com/i)?.[0];
  if (!url || jaAvisou) return;
  jaAvisou = true;

  // Grava no .env para a Twilio saber para onde mandar os eventos.
  let env = fs.readFileSync(envPath, 'utf8');
  env = /^PUBLIC_BASE_URL=.*$/m.test(env)
    ? env.replace(/^PUBLIC_BASE_URL=.*$/m, `PUBLIC_BASE_URL=${url}`)
    : env + `\nPUBLIC_BASE_URL=${url}\n`;
  fs.writeFileSync(envPath, env);

  console.log('\n  ==============================================================');
  console.log(`  Endereco publico: ${url}`);
  console.log('  PUBLIC_BASE_URL ja foi gravado no .env.');
  console.log('');
  console.log('  AGORA: reinicie o servidor (npm start) para ele usar o novo');
  console.log('  endereco. Deixe ESTA janela aberta enquanto estiver ligando.');
  console.log('  ==============================================================\n');
}

proc.stdout?.on('data', (d) => tratar(d.toString()));
proc.stderr?.on('data', (d) => tratar(d.toString())); // o cloudflared loga na stderr
proc.on('error', instalar);
proc.on('exit', (code) => {
  console.log(`\n  Tunel encerrado (codigo ${code}). As ligacoes param de funcionar ate reabrir.\n`);
});
