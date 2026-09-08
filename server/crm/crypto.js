/**
 * Criptografia das credenciais de CRM em repouso.
 *
 * Chave de API de terceiro (Pipedrive, HubSpot) e URL de webhook sao segredos
 * como qualquer outro: guardados em texto puro, quem tiver acesso ao arquivo
 * do banco tem acesso a conta do usuario no CRM dele. AES-256-GCM com uma
 * chave gerada por esta instalacao (mesmo padrao do segredo de sessao em
 * auth.js) resolve isso sem exigir configuracao nova do usuario.
 */
import crypto from 'node:crypto';
import { getSetting, setSetting } from '../db.js';

function chave() {
  let k = getSetting('segredo_crm');
  if (!k) {
    k = crypto.randomBytes(32).toString('hex');
    setSetting('segredo_crm', k);
  }
  return Buffer.from(k, 'hex');
}

export function encriptar(texto) {
  if (!texto) return null;
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const corpo = Buffer.concat([cifra.update(String(texto), 'utf8'), cifra.final()]);
  const tag = cifra.getAuthTag();
  return Buffer.concat([iv, tag, corpo]).toString('base64');
}

export function decriptar(base64) {
  if (!base64) return null;
  try {
    const dados = Buffer.from(base64, 'base64');
    const iv = dados.subarray(0, 12);
    const tag = dados.subarray(12, 28);
    const corpo = dados.subarray(28);
    const decifra = crypto.createDecipheriv('aes-256-gcm', chave(), iv);
    decifra.setAuthTag(tag);
    return Buffer.concat([decifra.update(corpo), decifra.final()]).toString('utf8');
  } catch {
    return null; // chave mudou ou dado corrompido: melhor null que travar o app
  }
}

/** Mostra so o fim da chave, para confirmar qual esta salva sem expor tudo. */
export const mascarar = (valor) => {
  const v = String(valor ?? '');
  return v.length <= 6 ? '••••••' : '••••' + v.slice(-4);
};
