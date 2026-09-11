/**
 * Garante que o TLS tenha certificados raiz.
 *
 * O driver do libsql (Rust) usa o "trust store" do sistema para falar HTTPS
 * com o Turso. Imagens de container enxutas (Debian slim, Alpine, e as que a
 * Railway monta com Nixpacks) as vezes nao trazem os certificados - o erro e
 * "TLS error: no valid native root CA certificates found" e o servidor nao
 * sobe. Aqui, se o sistema nao tiver o trust store, apontamos para o pacote
 * da Mozilla que vai junto no projeto (server/cacert.pem).
 *
 * Importe este arquivo ANTES de qualquer coisa que abra conexao TLS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' && !process.env.SSL_CERT_FILE && !process.env.SSL_CERT_DIR) {
  const doSistema = [
    '/etc/ssl/certs/ca-certificates.crt', // Debian, Ubuntu
    '/etc/pki/tls/certs/ca-bundle.crt', // Fedora, RHEL
    '/etc/ssl/cert.pem', // Alpine, BSD, macOS
    '/etc/ssl/ca-bundle.pem',
  ];
  if (!doSistema.some((p) => fs.existsSync(p))) {
    const embutido = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cacert.pem');
    if (fs.existsSync(embutido)) {
      process.env.SSL_CERT_FILE = embutido;
      console.log(`  [certs] trust store do sistema ausente - usando o pacote embutido (${embutido}).`);
    }
  }
}
