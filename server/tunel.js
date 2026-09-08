/**
 * Túnel do Cloudflare embutido no servidor.
 *
 * A Twilio precisa alcançar este computador para entregar os eventos da
 * ligação. Antes isso exigia duas janelas na ordem certa — e um túnel caído
 * derrubava a ligação no exato instante do "alô". Agora o próprio `npm start`
 * sobe o túnel, aprende o endereço e o reconecta sozinho se cair.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// O endereço do túnel tem várias palavras separadas por hífen
// (ex: market-asus-livestock-minds). Exigir 3+ evita capturar o
// "api.trycloudflare.com" que o próprio cloudflared usa por dentro.
const RE_URL = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+){2,}\.trycloudflare\.com/i;

const URLS_DOWNLOAD = {
  win32: { arquivo: 'cloudflared-windows-amd64.exe', nome: 'cloudflared.exe' },
  linux: { arquivo: 'cloudflared-linux-amd64', nome: 'cloudflared' },
};

function noSistema() {
  try {
    execSync('cloudflared --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Devolve o comando do cloudflared, baixando para bin/ se precisar. */
export async function garantirCloudflared({ silencioso = false } = {}) {
  if (noSistema()) return 'cloudflared';

  const alvo = URLS_DOWNLOAD[process.platform];
  if (!alvo) return null; // no Mac: brew install cloudflared

  const destino = path.join(raiz, 'bin', alvo.nome);
  if (fs.existsSync(destino)) return destino;

  if (!silencioso) console.log('  Baixando o cloudflared (uma vez so, ~50 MB)...');
  try {
    const res = await fetch(
      `https://github.com/cloudflare/cloudflared/releases/latest/download/${alvo.arquivo}`,
      { redirect: 'follow' }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    fs.mkdirSync(path.join(raiz, 'bin'), { recursive: true });
    fs.writeFileSync(destino, Buffer.from(await res.arrayBuffer()));
    if (process.platform !== 'win32') fs.chmodSync(destino, 0o755);
    if (!silencioso) console.log('  Pronto.\n');
    return destino;
  } catch (err) {
    console.error(`  Nao consegui baixar o cloudflared: ${err.message}`);
    return null;
  }
}

let processo = null;
let encerrando = false;

/**
 * Sobe o túnel e resolve com o endereço público.
 * `aoMudarEndereco` é chamado toda vez que o túnel reconecta com outro
 * endereço — quem chama usa isso para atualizar a configuração em memória.
 */
export async function iniciarTunel({ porta, aoMudarEndereco, silencioso = false }) {
  const comando = await garantirCloudflared({ silencioso });
  if (!comando) throw new Error('cloudflared indisponivel');

  return new Promise((resolve, reject) => {
    let resolvido = false;

    const subir = () => {
      processo = spawn(comando, ['tunnel', '--url', `http://localhost:${porta}`]);

      const ler = (buf) => {
        const texto = buf.toString();
        const url = texto.match(RE_URL)?.[0];
        if (!url) return;
        if (!resolvido) {
          resolvido = true;
          resolve(url);
        } else {
          console.log(`  Tunel reconectado: ${url}`);
          aoMudarEndereco?.(url);
        }
      };
      processo.stdout?.on('data', ler);
      processo.stderr?.on('data', ler); // o cloudflared loga na stderr

      processo.on('exit', (code) => {
        if (encerrando) return;
        console.log(`  Tunel caiu (codigo ${code}). Reconectando em 3s...`);
        setTimeout(subir, 3000);
      });
      processo.on('error', (err) => {
        if (!resolvido) reject(err);
      });
    };

    subir();
    setTimeout(() => {
      if (!resolvido) reject(new Error('o tunel nao respondeu em 60s'));
    }, 60000).unref?.();
  });
}

/** Fecha o túnel junto com o servidor. */
export function encerrarTunel() {
  encerrando = true;
  try {
    processo?.kill();
  } catch {
    /* ja morreu */
  }
}

for (const sinal of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sinal, () => {
    encerrarTunel();
    if (sinal !== 'exit') process.exit(0);
  });
}
