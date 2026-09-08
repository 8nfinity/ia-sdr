# IA SDR

Sistema de prospecção + discagem paralela com IA:

1. Você informa **segmento**, **região** e **quantidade**.
2. A IA busca empresas reais, valida (telefone, site, Instagram, existência) e monta a lista.
3. Você clica em **Salvar como lead** nas que interessam e manda **ligar para todas ao mesmo tempo**.
4. **A primeira que atender fica na linha; todas as outras são derrubadas na hora.**
5. As ligações saem **pelo seu telefone**: você entra na linha antes, e a empresa que atender cai direto em você — sem IA falando, sem apertar tecla.
6. Quem não atendeu recebe **uma** mensagem de WhatsApp escrita pela IA. A conversa dali em diante é sua.

---

## Duas maneiras de ligar

**1. Modo manual (aba "Discar") — sem conta nenhuma, custo zero.**
O sistema vira sua fila de discagem: mostra um lead por vez com telefone,
Instagram e site, você toca em **Ligar agora** (disca pelo seu próprio celular),
marca o resultado e ele já pula para o próximo. Abra o painel no celular pelo
endereço da rede local que aparece ao iniciar o servidor.
Não tem a corrida paralela — é você ligando, um por vez.

**2. Modo automático (Twilio) — a corrida paralela.**
Descrito abaixo. Exige conta Twilio, número e endereço público.

## Como a ligação funciona (modo direto)

1. Você salva os leads e clica em **Ligar para todos agora**.
2. O sistema liga **para o seu telefone** e avisa quantas empresas vão ser chamadas.
3. Você atende. **Só então** as empresas são discadas — todas ao mesmo tempo.
4. A primeira que atender cai **direto na sua linha**. As outras são desligadas no mesmo instante.
5. Você não aperta tecla nenhuma, e nenhuma IA fala com a empresa.

Se você não atender em 40 segundos (`ESPERA_VENDEDOR`), a campanha é cancelada e
nenhuma empresa é incomodada.

Quer o modo antigo, com a IA qualificando antes de te passar a ligação?
`MODO_LIGACAO=ia` no `.env`.

## WhatsApp

A IA manda **apenas a primeira mensagem** para quem não atendeu a ligação.
As respostas aparecem no painel e no seu WhatsApp — quem conduz a conversa é você.
(Para a IA responder sozinha: `WHATSAPP_AI_AUTOREPLY=true`.)

## Como iniciar

**Um comando só.** O `npm start` (ou o `INICIAR.bat`) sobe o servidor **e** o túnel
público que a Twilio usa para alcançar seu computador — na ordem certa, sozinho.
Se o túnel cair, ele reconecta e atualiza o endereço em memória e no `.env`.

Não precisa mais abrir duas janelas nem rodar `npm run tunel` antes.
(O comando continua existindo para uso avulso, e `TUNEL_AUTOMATICO=false`
desliga o túnel automático para quem tem domínio próprio.)


**Windows:** dê dois cliques em **`INICIAR.bat`**. Ele entra na pasta certa, instala o que faltar e sobe o servidor.

**Ou pelo terminal**, dentro da pasta do projeto:

```bash
npm start
```

Abra **http://localhost:3000**.

O `npm start` roda o [start.js](start.js), que antes de subir confere: versão do Node, dependências (instala sozinho se faltarem), arquivo `.env` (cria a partir do `.env.example`) e porta livre (se a 3000 estiver ocupada, sobe na 3001).

Requisito: **Node 22.5 ou mais novo** (usa o SQLite nativo do Node — não compila nada).

### Não sabe o que falta configurar?

```bash
npm run checar
```

Testa de verdade (bate na API) a chave da Anthropic, a conta Twilio, o endereço
público e o telefone do vendedor, e diz item por item o que falta e como resolver.

### Se der erro

| O que aparece | O que fazer |
|---|---|
| `A porta 3000 ja esta em uso` | Um servidor antigo ficou rodando. Feche a outra janela ou rode `taskkill /F /IM node.exe` |
| `Cannot find package 'express'` | Rode `npm install` na pasta do projeto (o `npm start` já tenta sozinho) |
| `Missing script: start` / `ENOENT package.json` | O terminal está em outra pasta. Use o `INICIAR.bat`, ou `cd` até a pasta do projeto |
| `node:sqlite` não existe / Node antigo | Instale o Node LTS em nodejs.org, feche o terminal e abra de novo |
| Aviso amarelo "Falta configurar a chave da IA" no painel | Preencha `ANTHROPIC_API_KEY` no `.env` e reinicie — sem ela a busca não roda |
| A página aparece **sem cor**, letra de jornal, tudo empilhado | Você abriu o `index.html` com dois cliques. Não funciona assim: use o `INICIAR.bat` e acesse `http://localhost:3000` |

> ⚠️ **Nunca abra o `web/index.html` direto.** Sem o servidor não há busca, ligação nem WhatsApp — a página fica crua. O `INICIAR.bat` já abre o navegador no endereço certo.

### Rode agora sem nenhuma conta

```bash
npm run demo    # cria 8 empresas fictícias só para ver a interface
npm start
```

Sem credenciais o sistema entra em **modo simulação**: a corrida de ligações, o vencedor, o cancelamento das outras e o handoff para o humano acontecem de verdade no painel — só não sai ligação telefônica. Você digita as falas da empresa na aba "Ligações ao vivo".

Para limpar os dados de demonstração, apague a pasta `data/`.

---

## Hospedar na internet

### Antes de tudo: senha no painel

```env
PAINEL_SENHA=uma-senha-longa-e-unica
```

Sem isso, quem descobrir a URL dispara buscas com o seu crédito da Anthropic e
ligações com o seu crédito da Twilio. Os webhooks (`/twiml`, `/webhooks`) ficam
fora da senha de propósito — quem chama é a Twilio e a Meta, e eles têm validação
própria (assinatura e verify token). Em produção ligue também:

```env
TWILIO_VALIDATE_SIGNATURE=true
PUBLIC_BASE_URL=https://sdr.seudominio.com.br
```

### Opção A — VPS com Docker (recomendada)

Serve qualquer VPS de ~US$ 5/mês (Hetzner, DigitalOcean, Contabo, Vultr).

1. Aponte um domínio para o IP do servidor
2. Edite o `Caddyfile` com esse domínio
3. Copie o projeto para o servidor (sem `node_modules` e sem `data`)
4. Crie o `.env` lá com as chaves reais
5. `docker compose up -d`

O Caddy emite e renova o certificado HTTPS sozinho. O banco fica no volume
`iasdr-dados`, então atualizar o sistema não apaga seus leads.

Atualizar depois: `git pull` (ou copiar os arquivos) e `docker compose up -d --build`.

### Opção B — Railway / Render (sem servidor para administrar)

Funciona, com **uma pegadinha**: o disco dessas plataformas é efêmero. Você
precisa criar um **volume persistente montado em `/app/data`**, senão a cada
deploy você perde os leads, o histórico de ligações e a fila de WhatsApp.

Configure as variáveis do `.env` no painel da plataforma e use a URL pública
que ela te dá como `PUBLIC_BASE_URL`.


### Vercel e Netlify não servem para este sistema

Não é limitação de configuração — é incompatibilidade de arquitetura. Elas rodam
**funções serverless** (acordam, respondem, morrem) e o sistema precisa do oposto:

| O sistema precisa | Vercel / Netlify |
|---|---|
| Busca da IA levando 3 a 8 minutos | função morre em 10s (Hobby) / 60s (Pro) |
| Painel ao vivo por WebSocket | sem suporte a WebSocket persistente |
| SQLite gravando leads, ligações e fila | disco efêmero, apaga a cada execução |
| Timers da campanha e fila do WhatsApp rodando sempre | não existe processo contínuo |

A corrida de ligações sozinha já inviabiliza: ela depende de timers vivos e de
trabalho que continua **depois** da resposta HTTP.

Onde hospedar, com a mesma facilidade (deploy pelo GitHub, sem administrar servidor):

| Plataforma | Como |
|---|---|
| **Render** | `render.yaml` já está pronto: New → Blueprint → escolha o repositório → preencha as chaves |
| **Railway** | New → Deploy from GitHub (ele detecta o `Dockerfile`) → adicione um **Volume em `/app/data`** → `DATA_DIR=/app/data` |
| **Fly.io** | `fly launch` → `fly volumes create dados` montado em `/app/data` |
| **VPS + Docker** | `docker compose up -d` (opção A acima) — mais barato e sem surpresa |

Em todas: **o volume em `/app/data` não é opcional.** Sem ele você perde leads,
histórico e fila a cada deploy. O endereço do banco aparece no log ao iniciar
(`banco: /app/data/iasdr.db`) — confira se bateu com o volume.


### Dá para hospedar de graça?

Depende do que "grátis" significa em cada plataforma. O sistema exige **ficar
ligado o tempo todo** e **disco que não apaga** — e é aí que a maioria dos free
tiers cai fora.

| Plataforma | Grátis hoje? | Serve? |
|---|---|---|
| **Oracle Cloud Always Free** | Sim, sem prazo (2 OCPU ARM / 12 GB) | ✅ VPS de verdade, sempre ligado, disco próprio |
| **Google Cloud e2-micro** | Sim, 1 instância sempre grátis | ✅ Funciona, mas é bem pequena |
| **Seu próprio PC + Cloudflare Tunnel** | Sim | ✅ `npm run tunel` — zero custo, funciona hoje |
| **Render Free** | Sim | ❌ Dorme após 15 min e **não aceita disco persistente** |
| **Railway** | Não (US$ 5 de teste) | ❌ Free tier acabou em 2023 |
| **Fly.io** | Não para contas novas | ❌ Free allowances encerradas em out/2024 |
| **Vercel / Netlify** | Sim | ❌ Serverless — incompatível (veja acima) |

O Render Free é o que mais engana: parece perfeito até você perceber que ele
**dorme** e que o SQLite é apagado a cada reinício. Dormindo, os eventos da
Twilio não chegam — a empresa atende e a ligação morre no silêncio.

#### Opção grátis mais rápida: seu próprio computador

```bash
npm run tunel      # numa janela — dá o endereço https e grava no .env
npm start          # noutra janela
```

O Cloudflare Tunnel publica o servidor local com HTTPS de graça. Limitação: o
endereço muda a cada execução (o script atualiza o `.env` sozinho, mas você
precisa reiniciar o servidor), e só funciona com o computador ligado. Para
endereço fixo, use um túnel nomeado com um domínio seu na Cloudflare.

#### Opção grátis permanente: Oracle Cloud

VPS ARM sempre grátis, sem prazo de validade. Depois de criar a máquina, é o
mesmo `docker compose up -d` da opção A. Avisos honestos: o cadastro pede
cartão (sem cobrança), a aprovação às vezes demora, a capacidade ARM esgota em
algumas regiões, e em 2026 a Oracle cortou a cota pela metade — pode mudar de
novo sem aviso.

> Lembre: hospedagem grátis não torna o resto grátis. Twilio e Anthropic
> continuam sendo cobradas por uso.

### Requisitos de qualquer hospedagem

| Requisito | Por quê |
|---|---|
| HTTPS com domínio próprio | A Twilio só entrega eventos de ligação em URL pública com certificado válido |
| Disco persistente em `/app/data` | É onde ficam leads, ligações, custos e a fila de WhatsApp (SQLite) |
| Processo sempre ligado | A fila de WhatsApp e as ligações dependem do servidor no ar |
| Node 24 | SQLite nativo, sem compilar nada (o Dockerfile já usa) |

Não precisa de banco de dados separado, Redis, nem nada além disso.

### Não use ngrok em produção

O `ngrok` serve para testar. A URL muda a cada reinício, e quando ela muda a
Twilio deixa de conseguir entregar os eventos — a ligação atende e morre no
silêncio.

## Configuração das integrações

Tudo fica no arquivo `.env`.

### 1. IA — Anthropic (obrigatória para busca inteligente e conversa)

```env
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-5
```

Pegue a chave em console.anthropic.com. É a IA que:
- audita se a empresa é real e é mesmo do segmento;
- acha o Instagram quando o site não mostra;
- escreve a abertura da ligação e conduz a conversa;
- escreve e responde as mensagens de WhatsApp.

As chamadas usam `fallbacks: "default"` (roteamento server-side): se um classificador recusar um pedido, a Anthropic reroteia em vez de derrubar a ligação no meio.

### 2. Busca de empresas — só com a IA (padrão)

```env
PROSPECT_SOURCE=claude
```

**Não precisa de mais nada além da `ANTHROPIC_API_KEY`.** A IA busca na web em rodadas: cada rodada pede um lote novo informando quem já foi encontrado, o que a obriga a varrer bairros e fontes diferentes em vez de repetir sempre as mesmas empresas famosas. Depois o sistema entra no site de cada uma para confirmar telefone, Instagram e e-mail.

Regra que está no prompt e não deve ser removida: **campo não encontrado vira `null`** — a IA não pode inventar telefone, site ou @.

Opcional, se um dia quiser telefone vindo direto da ficha do Google Maps:

```env
PROSPECT_SOURCE=places
GOOGLE_MAPS_API_KEY=AIza...
```

No Google Cloud Console: crie um projeto → ative **Places API (New)** → crie uma chave. `PROSPECT_SOURCE=auto` usa a IA se houver chave da Anthropic e cai para o Google se não houver.

### 3. Telefonia — Twilio + URL pública

```env
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+15551234567
PUBLIC_BASE_URL=https://seu-tunel.ngrok-free.app
HUMAN_AGENT_PHONE=+5511999999999
TWILIO_VALIDATE_SIGNATURE=true
```

A Twilio precisa **alcançar seu servidor** para entregar os eventos da ligação. Em desenvolvimento:

```bash
npx ngrok http 3000
```

e cole a URL `https://...` em `PUBLIC_BASE_URL`. Não precisa configurar nada no painel da Twilio: o sistema envia as URLs de callback em cada ligação.

Para ligar para números brasileiros a conta Twilio precisa ter **permissão de chamadas para o Brasil** habilitada (Voice → Geo Permissions) e saldo.

### 4. WhatsApp — três opções

```env
WHATSAPP_PROVIDER=meta          # meta | evolution | twilio | none
WHATSAPP_AI_AUTOREPLY=true
```

**a) Meta Cloud API (oficial):**
```env
META_WA_TOKEN=EAAG...
META_WA_PHONE_ID=123456789
META_WA_VERIFY_TOKEN=ia-sdr-verify
```
No painel da Meta, cadastre o webhook em `https://SEU_DOMINIO/webhooks/whatsapp` com o mesmo verify token.

**b) Evolution API (self-hosted, WhatsApp comum):**
```env
EVOLUTION_BASE_URL=https://evo.seudominio.com
EVOLUTION_API_KEY=...
EVOLUTION_INSTANCE=principal
```
Configure o webhook da instância para `https://SEU_DOMINIO/webhooks/whatsapp`.

**c) Twilio WhatsApp:**
```env
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
```
Webhook de mensagens recebidas: `https://SEU_DOMINIO/webhooks/whatsapp`.

### 5. Seu discurso

```env
COMPANY_NAME=Minha Empresa
COMPANY_PITCH=Ajudamos clínicas a lotar a agenda com prospecção automatizada.
SDR_AGENT_NAME=Alice
TTS_VOICE=Polly.Camila-Neural
```

---

## Como a corrida funciona por dentro

```
    startCampaign(10 empresas)
        │
        ├─ liga para o VENDEDOR e espera ele atender
        │     └─ não atendeu em 40s? cancela tudo, nenhuma empresa é chamada
        │
        ├─ 10 ligações disparadas EM PARALELO (Twilio, detecção de caixa postal ligada)
        │
        ├─ empresa #7 atende  ──►  POST /twiml/answer/:callId
        │                             │
        │                             ├─ é caixa postal? desliga, não vence a corrida
        │                             │
        │                             ├─ claimWinner()  ← UPDATE atômico no SQLite:
        │                             │    só a PRIMEIRA ligação atendida consegue marcar
        │                             │
        │                             ├─ vencedora ─► cancela as outras 9 na hora
        │                             │            ─► liga para o vendedor humano
        │                             │            ─► IA fala a abertura (Say + Gather pt-BR)
        │                             │
        │                             └─ perdedora ─► "desculpe, foi engano" + desliga
        │
        ├─ cada fala da pessoa ──► POST /twiml/turn/:callId ──► Claude responde
        │
        └─ vendedor atende e aperta 1 ──► POST /twiml/agent-accept/:callId
                                            └─ ligação da empresa é puxada para a
                                               sala de conferência: IA sai, humano entra
```

O ponto crítico — **duas empresas atenderem no mesmo segundo** — é resolvido por um `UPDATE ... WHERE winner_call_id IS NULL` no SQLite (`claimWinner`, em [server/db.js](server/db.js)). Só uma linha é alterada; a segunda ligação recebe a mensagem de cortesia e cai.

Caixa postal não vence a corrida porque a discagem usa `machineDetection: 'DetectMessageEnd'` **síncrono**: a Twilio só pede o TwiML depois de decidir se quem atendeu é humano ou máquina.

---

## Como a empresa é validada como "real"

Sem IA (sinais duros, em [server/prospect/validate.js](server/prospect/validate.js)):

| Sinal | Peso |
|---|---|
| Telefone E.164 válido com DDD brasileiro real | 35 (obrigatório) |
| Site próprio que responde de fato | 20 |
| Instagram encontrado no site ou pela IA | 12 |
| Avaliações no Google Maps | até 20 |
| Nota ≥ 4 | 5 |
| Endereço físico completo | 8 |
| E-mail público | 5 |
| Fonte citada pela IA (quando não há dados do Maps) | 8 |
| Fechada permanentemente no Maps | −60 |

Reprovação automática: sem telefone discável, score < 45, ou site que é agregador (iFood, Facebook, Linktree, diretórios de CNPJ...).

Depois disso, a IA faz uma auditoria final: *é empresa real? é mesmo desse segmento?* — e o score final é a média dos dois.

O sistema também **visita o site de cada empresa** (home, /contato, /fale-conosco) para extrair Instagram, e-mail, WhatsApp e telefone — o que serve de prova de que a empresa existe.

---

## Estrutura

```
server/
  config.js            .env + detecção de modo (real x simulação)
  db.js                SQLite nativo + claimWinner (corrida atômica)
  util.js              telefone BR, E.164, dedupe helpers
  ai/claude.js         busca, auditoria, script, conversa, WhatsApp
  prospect/
    places.js          Google Places API (New)
    scrape.js          visita o site: instagram, e-mail, telefone
    validate.js        score técnico + dedupe
    index.js           pipeline completo
  voice/
    provider.js        Twilio real  |  simulador
    campaign.js        motor da corrida e do handoff
    twiml-builder.js   XML que a Twilio executa
    twiml.js           webhooks de voz
  whatsapp/
    providers.js       Meta / Evolution / Twilio
    index.js           envio, webhook, resposta automática
  routes/api.js        API REST do painel
web/                   painel (busca, corrida ao vivo, WhatsApp)
data/iasdr.db          banco local
```

---

## Limitações e próximos passos

- **Latência da voz:** o fluxo usa `<Say>` + `<Gather>` da Twilio (TTS + reconhecimento de fala). Cada turno leva ~2–4s. Para conversa fluida de verdade, o próximo passo é migrar `voice/twiml.js` para **Twilio ConversationRelay** (streaming de áudio via WebSocket), mantendo o mesmo motor de `campaign.js`.
- **Um humano por campanha:** hoje o handoff chama um número (`HUMAN_AGENT_PHONE`). Fila com vários vendedores é uma extensão natural de `callHumanAgent`.
- **Custo por campanha:** cada ligação da corrida é cobrada pela Twilio pelo tempo de toque/atendimento, mesmo as canceladas.

## Antes de usar em produção

Cold call automatizado tem regras. Vale conferir, pelo menos:

- **A IA se identifica como assistente virtual** quando perguntam — isso já está no prompt e não deve ser removido.
- **Respeite o "não quero"**: a IA encerra e o status vai para "sem interesse". Mantenha uma lista de não-perturbe (o campo `status` da empresa serve para isso).
- **Horário comercial** para ligações e mensagens.
- **LGPD**: dados de empresas coletados de fontes públicas ainda exigem base legal e finalidade — e o titular pode pedir exclusão.
- Para o **WhatsApp oficial (Meta)**, o primeiro contato ativo exige **template aprovado**; o texto livre só vale dentro da janela de 24h após a empresa responder.
