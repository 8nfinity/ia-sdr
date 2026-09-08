/** Mostra o TwiML que cada lado da ligação recebe. Útil para conferir mudanças. */
import { conferenceXml } from '../server/voice/twiml-builder.js';

const limpar = (x) => x.replace('<?xml version="1.0" encoding="UTF-8"?>', '');

console.log('\nVENDEDOR (entra primeiro, espera com música):');
console.log(limpar(conferenceXml('iasdr_sala', 'Aguarde. Chamando 10 empresas.', { aguardando: true })));

console.log('\nEMPRESA (entra depois; o bipe dela é o que o vendedor ouve):');
console.log(limpar(conferenceXml('iasdr_sala')));
console.log('');
