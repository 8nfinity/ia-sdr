// Abrir o index.html com dois cliques (file://) carrega a pagina sem servidor:
// nada de busca, nada de ligacao. Avisa em vez de deixar a tela morta.
if (location.protocol === 'file:') {
  document.body.innerHTML = `
    <div style="max-width:560px;margin:70px auto;padding:26px;background:#2a2620;
                border:1px solid rgba(217,164,65,.45);border-radius:10px;
                font-family:Inter,Segoe UI,sans-serif;color:#f0f1f2">
      <h2 style="color:#d9a441;margin:0 0 12px">Você abriu o arquivo direto — assim não funciona.</h2>
      <p style="color:#9aa3a0;margin:0 0 14px">
        O IA SDR precisa do servidor rodando: é ele que busca as empresas, liga e conversa no WhatsApp.
      </p>
      <ol style="color:#9aa3a0;line-height:1.9;padding-left:20px;margin:0">
        <li>Na pasta do projeto, dê dois cliques em <b style="color:#8ec9ae">INICIAR.bat</b><br />
            (ou abra o terminal na pasta e rode <b style="color:#8ec9ae">npm start</b>)</li>
        <li>Acesse <a href="http://localhost:3000" style="color:#8ec9ae">http://localhost:3000</a></li>
      </ol>
    </div>`;
  throw new Error('aberto via file:// — abra http://localhost:3000');
}

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  searchId: null,
  companies: [],
  saved: new Set(),      // leads salvos = quem vai receber ligação
  campaignId: null,
  modoLigacao: 'direto',
  winnerCallId: null,
  calls: new Map(),
  mode: 'simulation',
  thread: null,
  threadCompany: null,
};

const api = async (path, options = {}) => {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/entrar.html';
    throw new Error('sessão expirada');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'falha na requisição');
  return data;
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4200);
}

// ───────────────────────────────── navegação
$$('.tab').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.remove('active'));
    $$('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    $('#tab-' + btn.dataset.tab).classList.add('active');
    $('#action-bar').hidden = btn.dataset.tab !== 'prospect';
    history.replaceState(null, '', '#' + btn.dataset.tab);
    if (btn.dataset.tab === 'live') $('#nav-live').classList.remove('on');
    if (btn.dataset.tab === 'whats') loadThreads();
    if (btn.dataset.tab === 'discar') loadFila();
  })
);
const goTo = (tab) => $$('.tab').find((b) => b.dataset.tab === tab)?.click();

// ───────────────────────────────── status
async function loadStatus() {
  const s = await api('/status');
  state.mode = s.modoVoz;
  state.empresa = s.empresa;
  $('#integrations').innerHTML = Object.entries(s.integracoes)
    .map(([k, v]) => `<span class="integ ${v.ok ? 'ok' : ''}" title="${esc(v.detail)}"><i></i>${esc(k)}</span>`)
    .join('');
  // Telefone do vendedor fica salvo no sistema: digitou uma vez, vale para as
  // próximas campanhas e para o teste de ligação.
  if (s.telefoneVendedor && !$('#agent-phone').value) $('#agent-phone').value = s.telefoneVendedor;

  // Sem provedor de WhatsApp, a chave não pode ficar ligada fingindo que envia.
  const temWhats = s.whatsappProvider && s.whatsappProvider !== 'none';
  const chave = $('#wa-followup');
  chave.disabled = !temWhats;
  chave.checked = temWhats;
  chave.closest('.switch').title = temWhats
    ? `Mensagem enviada via ${s.whatsappProvider}`
    : 'WhatsApp desativado: configure WHATSAPP_PROVIDER no .env';
  chave.closest('.switch').classList.toggle('off', !temWhats);
  const rotulo = chave.closest('.switch');
  rotulo.lastChild.textContent = temWhats
    ? ' WhatsApp p/ quem não atender'
    : ' WhatsApp desativado';

  const pill = $('#mode-pill');
  pill.textContent = s.modoVoz === 'twilio' ? 'ligações reais' : 'simulação';
  pill.classList.toggle('real', s.modoVoz === 'twilio');
  $('#aviso-simulacao').hidden = s.modoVoz === 'twilio';

  // Sem fonte de busca configurada o botão Buscar não tem o que fazer:
  // avisa na tela, com o passo a passo, em vez de falhar só no clique.
  const prontoParaBuscar = s.integracoes.prospeccao.ok;
  $('#setup').hidden = prontoParaBuscar;
  $('#search-btn').disabled = !prontoParaBuscar;
  if (!prontoParaBuscar) {
    $('#setup-note').textContent = 'Detalhe do servidor: ' + s.integracoes.prospeccao.detail;
    $('#search-btn').title = 'Configure a chave da IA para buscar';
  }
}

// ───────────────────────────────── custo
const usd = (v) => 'US$ ' + Number(v ?? 0).toFixed(v < 1 ? 3 : 2).replace('.', ',');

async function loadCustos() {
  try {
    const c = await api('/custos');
    $('#gasto-pill').textContent = `${usd(c.hoje.usd)} hoje`;
    $('#gasto-pill').title =
      `Gasto de API hoje: ${usd(c.hoje.usd)} em ${c.hoje.chamadas} chamadas\n` +
      `Acumulado: ${usd(c.total.usd)}\n` +
      c.porTipo.map((t) => `  ${t.tipo}: ${usd(t.usd)} (${t.chamadas}x)`).join('\n');
  } catch { /* sem dados ainda */ }
}

// ───────────────────────────────── busca
$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  setSearching(true);
  $('#search-progress').hidden = false;
  $('#search-progress').innerHTML = '';
  try {
    const { searchId } = await api('/search', {
      method: 'POST',
      body: { segment: f.get('segment'), region: f.get('region'), quantity: Number(f.get('quantity')) },
    });
    state.searchId = searchId;
  } catch (err) {
    step('Erro: ' + err.message, true);
    setSearching(false);
  }
});

function setSearching(on) {
  const btn = $('#search-btn');
  btn.classList.toggle('loading', on);
  btn.disabled = on;
  btn.querySelector('.label').textContent = on ? 'Buscando' : 'Buscar';
}

function step(msg, isError = false) {
  const box = $('#search-progress');
  box.hidden = false;
  const div = document.createElement('div');
  div.className = 'step' + (isError ? ' err' : '');
  div.textContent = msg;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ───────────────────────────────── importar planilha
const areaPlanilha = $('#area-planilha');
const inputPlanilha = $('#arquivo-planilha');

['dragenter', 'dragover'].forEach((ev) =>
  areaPlanilha.addEventListener(ev, (e) => {
    e.preventDefault();
    areaPlanilha.classList.add('arrastando');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  areaPlanilha.addEventListener(ev, (e) => {
    e.preventDefault();
    areaPlanilha.classList.remove('arrastando');
  })
);
areaPlanilha.addEventListener('drop', (e) => {
  const arquivo = e.dataTransfer?.files?.[0];
  if (arquivo) importarPlanilha(arquivo);
});
inputPlanilha.addEventListener('change', (e) => {
  const arquivo = e.target.files?.[0];
  if (arquivo) importarPlanilha(arquivo);
  e.target.value = ''; // permite reimportar o mesmo arquivo
});

async function importarPlanilha(arquivo) {
  const box = $('#importar-resultado');
  box.hidden = false;
  box.className = 'importar-resultado';
  box.textContent = `Lendo ${arquivo.name}...`;

  try {
    // O arquivo vai em base64 no corpo: simples e sem dependência de upload.
    const base64 = await new Promise((resolve, reject) => {
      const leitor = new FileReader();
      leitor.onload = () => resolve(String(leitor.result));
      leitor.onerror = () => reject(new Error('não consegui ler o arquivo'));
      leitor.readAsDataURL(arquivo);
    });

    const r = await api('/importar', { method: 'POST', body: { arquivo: base64, nome: arquivo.name } });
    state.searchId = r.searchId;
    renderCompanies(r.companies);

    const ignorados = r.totalIgnorados
      ? ` · <span class="ign">${r.totalIgnorados} ignorado(s)</span>`
      : '';
    box.className = 'importar-resultado ok';
    box.innerHTML =
      `<strong>${r.importados} contatos importados</strong>${ignorados}<br />` +
      `<span class="det">nome: coluna "${esc(r.colunas.nome)}" · telefone: coluna "${esc(r.colunas.telefone)}"</span>` +
      (r.ignorados.length
        ? `<div class="det ign">${r.ignorados
            .slice(0, 5)
            .map((i) => `${esc(i.nome)} — ${esc(i.telefone || 'vazio')} (${esc(i.motivo)})`)
            .join('<br />')}</div>`
        : '');
    toast(`${r.importados} contatos prontos para ligar.`);
  } catch (err) {
    box.className = 'importar-resultado erro';
    box.textContent = err.message;
  }
}

// ───────────────────────────────── leads
function renderCompanies(list) {
  state.companies = list;
  state.saved = new Set(list.filter((c) => c.status === 'lead').map((c) => c.id));

  const box = $('#results');
  if (!list.length) {
    box.innerHTML = '<div class="empty">Nenhuma empresa aprovada. Tente um segmento mais amplo ou outra cidade.</div>';
    $('#results-actions').hidden = true;
    $('#summary').textContent = '';
    updateSaved();
    return;
  }

  box.innerHTML = list.map(leadHtml).join('');
  $('#results-actions').hidden = false;
  $('#export-csv').href = `/api/searches/${state.searchId}/csv`;
  const comTel = list.filter((c) => c.phone_e164).length;
  const media = Math.round(list.reduce((a, c) => a + (c.score || 0), 0) / list.length);
  $('#summary').textContent = `${list.length} empresas · ${comTel} com telefone · score médio ${media}`;

  $$('.lead .btn').forEach((btn) => btn.addEventListener('click', () => toggleSave(btn.dataset.id)));
  updateSaved();
}

function leadHtml(c) {
  const meta = [
    c.phone_e164
      ? `<span>${esc(c.phone_e164)}</span>${c.tipo_telefone === 'celular' ? '<span class="tag-tel">celular</span>' : ''}`
      : '',
    c.instagram
      ? `<a href="https://instagram.com/${esc(c.instagram.replace('@', ''))}" target="_blank" rel="noopener">${esc(c.instagram)}</a>`
      : '',
    c.website ? `<a href="${esc(c.website)}" target="_blank" rel="noopener">${esc(c.website)}</a>` : '',
  ].filter(Boolean).join('<span class="sep">·</span>');

  const prova = c.reviews
    ? `${c.reviews} avaliações no Maps${c.rating ? ` · nota ${c.rating}` : ''}`
    : (() => {
        try { return JSON.parse(c.reasons || '[]').slice(0, 2).join(' · '); } catch { return ''; }
      })();

  // Dado da Receita: quem decide e o telefone registrado no CNPJ.
  const receita = [
    c.decisor ? `<b>sócio:</b> ${esc(c.decisor)}` : '',
    c.celular_responsavel ? `<b>celular do responsável:</b> ${esc(c.celular_responsavel)}` : '',
    c.phone_receita && c.phone_receita !== c.phone_e164 ? `<b>tel. Receita:</b> ${esc(c.phone_receita)}` : '',
    c.situacao && !/ATIVA/i.test(c.situacao) ? `<b>CNPJ ${esc(c.situacao)}</b>` : '',
  ].filter(Boolean).join(' · ');

  const salvo = c.status === 'lead';
  return `<div class="lead ${salvo ? 'saved' : ''}" data-lead="${c.id}">
    <div class="lead-main">
      <div class="lead-name">${esc(c.name)}
        <span class="lead-score ${c.score >= 70 ? 'good' : ''}">${c.score ?? 0}</span></div>
      <div class="lead-meta">${meta || 'sem canais encontrados'}</div>
      ${prova ? `<div class="lead-why">${esc(prova)}</div>` : ''}
      ${receita ? `<div class="lead-receita">${receita}</div>` : ''}
    </div>
    <button class="btn ${salvo ? 'ghost' : 'accent'}" data-id="${c.id}" ${c.phone_e164 ? '' : 'disabled title="sem telefone para ligar"'}>
      ${salvo ? 'Lead salvo ✓' : 'Salvar como lead'}
    </button>
  </div>`;
}

async function toggleSave(id) {
  const company = state.companies.find((c) => c.id === id);
  if (!company) return;
  const salvar = !state.saved.has(id);
  salvar ? state.saved.add(id) : state.saved.delete(id);
  company.status = salvar ? 'lead' : 'novo';

  const card = $(`.lead[data-lead="${id}"]`);
  const btn = card?.querySelector('.btn');
  card?.classList.toggle('saved', salvar);
  if (btn) {
    btn.textContent = salvar ? 'Lead salvo ✓' : 'Salvar como lead';
    btn.className = 'btn ' + (salvar ? 'ghost' : 'accent');
  }
  updateSaved();
  try {
    await api('/companies/' + id, { method: 'PATCH', body: { status: company.status } });
  } catch { /* o painel já refletiu; o status volta na próxima carga */ }
}

$('#save-all').addEventListener('click', () => {
  const alvo = state.companies.filter((c) => c.phone_e164);
  const salvarTodos = state.saved.size < alvo.length;
  alvo.forEach((c) => {
    if (salvarTodos !== state.saved.has(c.id)) toggleSave(c.id);
  });
  $('#save-all').textContent = salvarTodos ? 'limpar seleção' : 'salvar todos';
});

function updateSaved() {
  $('#selected-count').textContent = state.saved.size;
  $('#start-campaign').disabled = state.saved.size === 0;
}

// ───────────────────────────────── campanha
// Ao sair do campo, o número vira o padrão do sistema (fica no banco).
$('#agent-phone').addEventListener('change', async (e) => {
  const telefone = e.target.value.trim();
  if (!telefone) return;
  try {
    const r = await api('/settings/vendedor', { method: 'POST', body: { telefone } });
    e.target.value = r.telefone;
    toast('Telefone do vendedor salvo: ' + r.telefone);
    loadStatus();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#start-campaign').addEventListener('click', async () => {
  const btn = $('#start-campaign');
  btn.disabled = true;
  try {
    await api('/campaigns', {
      method: 'POST',
      body: {
        companyIds: [...state.saved],
        agentPhone: $('#agent-phone').value || undefined,
        whatsappFollowup: $('#wa-followup').checked,
      },
    });
    goTo('live');
  } catch (err) {
    toast('Erro ao iniciar: ' + err.message, true);
    btn.disabled = false;
  }
});

$('#stop-campaign').addEventListener('click', async () => {
  if (!state.campaignId) return;
  await api(`/campaigns/${state.campaignId}/stop`, { method: 'POST' });
  toast('Campanha encerrada.');
});

const DEAD = ['encerrada', 'no-answer', 'falha', 'ocupado', 'voicemail'];
const LABEL = {
  criada: 'preparando...',
  discando: 'discando...',
  chamando: 'tocando...',
  atendida: 'ATENDEU — na linha',
  'com humano': 'ATENDEU — com o vendedor',
  encerrada: 'encerrada',
  'no-answer': 'não atendeu',
  voicemail: 'caixa postal',
  ocupado: 'ocupado',
  falha: 'falhou',
};

function renderCalls() {
  const box = $('#calls');
  const calls = [...state.calls.values()];
  if (!calls.length) {
    box.innerHTML = '<div class="empty">Nenhuma campanha ativa. Salve leads na aba Prospecção e dispare a corrida.</div>';
    return;
  }
  calls.sort((a, b) => (b.winner ? 1 : 0) - (a.winner ? 1 : 0));
  box.innerHTML = calls
    .map((c) => {
      const dead = DEAD.includes(c.status) && !c.winner;
      const cls = c.winner ? 'winner' : dead ? 'dead' : 'ringing';
      const handoff =
        c.agentState === 'ringing'
          ? '<div class="handoff-line">chamando o vendedor humano...</div>'
          : c.agentState === 'bridged'
            ? '<div class="handoff-line done">vendedor humano assumiu a ligação</div>'
            : '';
      return `<div class="call ${cls}">
        <div class="nm">${esc(c.name)}</div>
        <div class="ph">${esc(c.to)}</div>
        <div class="st"><i></i>${esc(LABEL[c.status] ?? c.status)}</div>
        ${c.detail ? `<div class="sub-st">${esc(c.detail)}</div>` : ''}
        ${handoff}
      </div>`;
    })
    .join('');
}

function addBubble(role, text) {
  const box = $('#transcript');
  box.querySelector('.empty')?.remove();
  const cls = role === 'assistant' ? 'ai' : role === 'user' ? 'person' : 'sys';
  const who = role === 'assistant' ? 'IA SDR' : role === 'user' ? 'Empresa' : '';
  const div = document.createElement('div');
  div.className = 'bubble ' + cls;
  div.innerHTML = (who ? `<span class="who">${who}</span>` : '') + esc(text);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ───────────────────────────────── simulação
$('#sim-send').addEventListener('click', async () => {
  const input = $('#sim-speech');
  if (!state.winnerCallId || !input.value.trim()) return;
  const speech = input.value.trim();
  input.value = '';
  try {
    await api(`/calls/${state.winnerCallId}/speech`, { method: 'POST', body: { speech } });
  } catch (err) {
    toast(err.message, true);
  }
});
$('#sim-speech').addEventListener('keydown', (e) => e.key === 'Enter' && $('#sim-send').click());
$('#sim-accept').addEventListener('click', async () => {
  if (!state.winnerCallId) return toast('Ninguém atendeu ainda.', true);
  try {
    await api(`/calls/${state.winnerCallId}/accept-agent`, { method: 'POST' });
  } catch (err) {
    toast(err.message, true);
  }
});

// ───────────────────────────────── whatsapp
async function loadThreads() {
  const threads = await api('/whatsapp/threads');
  const box = $('#threads');
  if (!threads.length) {
    box.innerHTML = '<div class="empty">Nenhuma conversa ainda.</div>';
    return;
  }
  box.innerHTML = threads
    .map(
      (t) => `<div class="thread-item ${state.thread === t.phone ? 'active' : ''}"
        data-phone="${esc(t.phone)}" data-company="${esc(t.company_id ?? '')}" data-name="${esc(t.company?.name ?? t.phone)}">
        <div class="nm">${esc(t.company?.name ?? t.phone)}</div>
        <div class="last">${esc(t.last_body ?? '')}</div>
      </div>`
    )
    .join('');
  $$('.thread-item').forEach((el) =>
    el.addEventListener('click', () => openThread(el.dataset.phone, el.dataset.company, el.dataset.name))
  );
}

async function openThread(phone, companyId, title) {
  state.thread = phone;
  state.threadCompany = companyId || null;
  $('#thread-title').textContent = title || phone;
  $('#wa-send').disabled = false;
  const msgs = await api('/whatsapp/thread/' + encodeURIComponent(phone));
  $('#thread').innerHTML = msgs
    .map(
      (m) =>
        `<div class="bubble ${m.direction === 'out' ? 'ai' : 'person'}"><span class="who">${
          m.direction === 'out' ? 'nós' : 'empresa'
        }</span>${esc(m.body)}</div>`
    )
    .join('');
  $('#thread').scrollTop = $('#thread').scrollHeight;
  loadThreads();
}

$('#wa-send').addEventListener('click', async () => {
  if (!state.threadCompany) return toast('Conversa sem empresa vinculada na base.', true);
  const text = $('#wa-text').value.trim();
  $('#wa-text').value = '';
  try {
    await api('/whatsapp/send', {
      method: 'POST',
      body: { companyId: state.threadCompany, text: text || undefined },
    });
  } catch (err) {
    toast('Erro: ' + err.message, true);
  }
});
$('#wa-text').addEventListener('keydown', (e) => e.key === 'Enter' && $('#wa-send').click());

// ───────────────────────────────── fila de discagem manual
state.fila = [];
state.atual = null;

async function loadFila() {
  const { fila, trabalhados } = await api('/leads');
  state.fila = fila;
  $('#fila-count').textContent = fila.length || '';
  $('#fila-feitos').textContent = trabalhados.length
    ? `${trabalhados.length} já trabalhados`
    : '';

  if (!fila.length) {
    $('#discar-vazio').hidden = false;
    $('#lead-atual').hidden = true;
    $('#fila-head').hidden = true;
    $('#fila-lista').innerHTML = '';
    return;
  }

  $('#discar-vazio').hidden = true;
  mostrarLead(0);

  $('#fila-head').hidden = false;
  $('#fila-restantes').textContent = fila.length;
  $('#fila-lista').innerHTML = fila
    .slice(1, 15)
    .map(
      (c) => `<div class="lead"><div class="fila-item">
        <div><div class="n">${esc(c.name)}</div><div class="t">${esc(c.phone_e164 ?? '')}</div></div>
        <span class="lead-score ${c.score >= 70 ? 'good' : ''}">${c.score ?? 0}</span>
      </div></div>`
    )
    .join('');
}

function mostrarLead(indice) {
  const c = state.fila[indice];
  if (!c) return loadFila();
  state.atual = c;

  $('#lead-atual').hidden = false;
  $('#la-pos').textContent = `${indice + 1} de ${state.fila.length}`;
  $('#la-score').textContent = c.score ?? 0;
  $('#la-nome').textContent = c.name;

  const partes = [
    c.phone_e164 ? `<strong>${esc(c.phone_e164)}</strong>` : 'sem telefone',
    c.address ? esc(c.address) : '',
    c.instagram
      ? `<a href="https://instagram.com/${esc(c.instagram.replace('@', ''))}" target="_blank" rel="noopener">${esc(c.instagram)}</a>`
      : '',
    c.website ? `<a href="${esc(c.website)}" target="_blank" rel="noopener">site</a>` : '',
  ].filter(Boolean);
  const extra = [
    c.decisor ? `sócio: <b>${esc(c.decisor)}</b>` : '',
    c.celular_responsavel ? `celular do responsável: <b>${esc(c.celular_responsavel)}</b>` : '',
    c.phone_receita && c.phone_receita !== c.phone_e164
      ? `<a href="tel:${esc(c.phone_receita)}">tel. Receita: ${esc(c.phone_receita)}</a>`
      : '',
  ].filter(Boolean).join(' · ');
  $('#la-meta').innerHTML = partes.join(' · ') + (extra ? `<div class="lead-receita">${extra}</div>` : '');

  const numero = (c.phone_e164 || '').replace(/D/g, '');
  $('#la-ligar').href = 'tel:' + (c.phone_e164 || '');
  // Celular do responsavel ganha botao proprio: e a ligacao que nao passa
  // por recepcao, entao merece estar a um toque de distancia.
  const btnCel = $('#la-celular');
  btnCel.hidden = !c.celular_responsavel;
  if (c.celular_responsavel) btnCel.href = 'tel:' + c.celular_responsavel;
  const msg = encodeURIComponent(
    `Olá! Sou da ${state.empresa?.companyName ?? 'nossa empresa'}. Tentei falar com vocês por telefone. Posso explicar em 2 minutos?`
  );
  $('#la-whats').href = `https://wa.me/${numero}?text=${msg}`;
}

function avancar() {
  const i = state.fila.findIndex((c) => c.id === state.atual?.id);
  const proximo = state.fila[i + 1];
  if (proximo) {
    state.fila = state.fila.filter((c) => c.id !== state.atual.id);
    mostrarLead(state.fila.findIndex((c) => c.id === proximo.id));
    $('#fila-restantes').textContent = state.fila.length;
    $('#fila-count').textContent = state.fila.length || '';
  } else {
    loadFila();
  }
}

document.querySelectorAll('[data-resultado]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    if (!state.atual) return;
    const resultado = btn.dataset.resultado;
    const empresa = state.atual;
    try {
      await api('/companies/' + empresa.id, { method: 'PATCH', body: { status: resultado } });
      toast(`${empresa.name}: ${resultado}`);
    } catch (err) {
      toast(err.message, true);
    }
    avancar();
  })
);

$('#la-pular').addEventListener('click', avancar);

$('#la-copiar').addEventListener('click', async () => {
  if (!state.atual?.phone_e164) return;
  try {
    await navigator.clipboard.writeText(state.atual.phone_e164);
    toast('Número copiado: ' + state.atual.phone_e164);
  } catch {
    toast('Não consegui copiar. Número: ' + state.atual.phone_e164, true);
  }
});

// ───────────────────────────────── websocket
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => setTimeout(connect, 2000);
}

function handle(ev) {
  switch (ev.type) {
    case 'log': {
      const el = $('#log');
      el.querySelector('.empty')?.remove();
      const d = document.createElement('div');
      d.innerHTML = `<span class="sc">${esc(ev.scope)}</span> ${esc(ev.message)}`;
      el.appendChild(d);
      el.scrollTop = el.scrollHeight;
      break;
    }
    case 'search:step':
      step(ev.message);
      break;
    case 'search:custo':
      step(
        `Custo desta busca: ${usd(ev.usd)} — ${(ev.entrada + ev.saida).toLocaleString('pt-BR')} tokens ` +
          `e ${ev.buscas} buscas na web em ${ev.chamadas} chamadas de IA.`
      );
      loadCustos();
      break;
    case 'search:done':
      state.searchId = ev.searchId;
      renderCompanies(ev.companies);
      setSearching(false);
      toast(`${ev.companies.length} empresas encontradas.`);
      break;
    case 'search:error':
      step('ERRO: ' + ev.message, true);
      setSearching(false);
      toast(ev.message, true);
      break;
    case 'campaign:aguardando-vendedor':
      $('#agent-status').hidden = false;
      $('#agent-status').className = 'agent-status waiting';
      $('#agent-status').textContent =
        `Ligando para o vendedor (${ev.agente}). Assim que ele atender, as ${ev.empresas} empresas serão chamadas.`;
      break;
    case 'campaign:vendedor-pronto':
      $('#agent-status').className = 'agent-status ready';
      $('#agent-status').textContent = 'Vendedor na linha. Discando para as empresas agora...';
      break;
    case 'campaign:erro':
      $('#agent-status').className = 'agent-status err';
      $('#agent-status').textContent = ev.message;
      toast(ev.message, true);
      $('#start-campaign').disabled = false;
      break;
    case 'campaign:start':
      state.campaignId = ev.campaignId;
      state.modoLigacao = ev.modo ?? 'direto';
      state.winnerCallId = null;
      state.calls = new Map(
        ev.calls.map((c) => [c.id, { id: c.id, name: c.company?.name ?? '—', to: c.to_number, status: 'discando' }])
      );
      $('#transcript').innerHTML = '<div class="empty">Aguardando alguém atender...</div>';
      $('#stop-campaign').hidden = false;
      $('#talk-tag').hidden = true;
      $('#sim-controls').hidden = ev.mode !== 'simulation' || state.modoLigacao === 'direto';
      $('#conversa-box').hidden = state.modoLigacao === 'direto';
      $('#nav-live').classList.add('on');
      $('#start-campaign').disabled = false;
      renderCalls();
      break;
    case 'call:update': {
      const c = state.calls.get(ev.callId);
      if (!c) break;
      if (ev.status) c.status = ev.status;
      if (ev.detail) c.detail = ev.detail;
      if (ev.agentState) c.agentState = ev.agentState;
      renderCalls();
      break;
    }
    case 'call:winner': {
      state.winnerCallId = ev.callId;
      const c = state.calls.get(ev.callId);
      if (c) { c.winner = true; c.status = 'atendida'; c.detail = null; }
      $('#transcript').innerHTML = '';
      $('#talk-tag').hidden = false;
      renderCalls();
      toast(`${ev.company?.name ?? 'Empresa'} atendeu — as outras foram encerradas.`);
      break;
    }
    case 'call:transcript':
      if (ev.callId === state.winnerCallId) addBubble(ev.role, ev.text);
      break;
    case 'call:handoff': {
      addBubble('system', ev.direto ? '— empresa conectada ao vendedor —' : '— IA saiu · vendedor humano assumiu —');
      if (ev.direto) {
        $('#agent-status').className = 'agent-status ready';
        $('#agent-status').textContent = 'Empresa na linha com o vendedor. As outras foram encerradas.';
      }
      const c = state.calls.get(ev.callId);
      if (c) { c.agentState = 'bridged'; c.status = 'com humano'; renderCalls(); }
      loadCustos();
      break;
    }
    case 'campaign:end':
      $('#stop-campaign').hidden = true;
      $('#talk-tag').hidden = true;
      break;
    case 'whatsapp:message':
      if (state.thread === ev.phone) openThread(ev.phone, ev.company_id ?? state.threadCompany, $('#thread-title').textContent);
      else loadThreads();
      break;
  }
}

// ───────────────────────────────── estado inicial
async function loadLastSearch() {
  try {
    const buscas = await api('/searches');
    const ultima = buscas.find((b) => b.status === 'concluida');
    if (!ultima) return;
    const { search, companies } = await api('/searches/' + ultima.id);
    if (!companies.length) return;
    state.searchId = search.id;
    renderCompanies(companies);
    $('#search-form').segment.value = search.segment;
    $('#search-form').region.value = search.region;
    $('#search-form').quantity.value = search.quantity;
  } catch { /* primeira execução */ }
}

/** Campanha em andamento é remontada — o painel aguenta um F5. */
async function loadActiveCampaign() {
  try {
    const campanhas = await api('/campaigns');
    const ativa = campanhas.find((c) => c.status !== 'finalizada');
    if (!ativa) return;
    const { campaign, calls } = await api('/campaigns/' + ativa.id);
    state.campaignId = campaign.id;
    state.modoLigacao = campaign.modo ?? 'direto';
    $('#conversa-box').hidden = state.modoLigacao === 'direto';
    state.calls = new Map(
      calls.map((c) => [
        c.id,
        {
          id: c.id,
          name: c.company?.name ?? '—',
          to: c.to_number,
          status: c.status,
          winner: Boolean(c.is_winner),
          agentState: c.agent_state,
          detail: c.is_winner ? null : c.outcome,
        },
      ])
    );
    const vencedora = calls.find((c) => c.is_winner);
    if (vencedora) {
      state.winnerCallId = vencedora.id;
      $('#transcript').innerHTML = '';
      vencedora.transcript.forEach((t) => addBubble(t.role, t.text));
      $('#talk-tag').hidden = false;
    }
    $('#stop-campaign').hidden = false;
    $('#sim-controls').hidden = campaign.mode !== 'simulation' || state.modoLigacao === 'direto';
    $('#nav-live').classList.add('on');
    renderCalls();
  } catch { /* sem campanha */ }
}

function restoreTab() {
  const tab = location.hash.replace('#', '');
  if (tab && $('#tab-' + tab)) goTo(tab);
}

// Quem está logado. Admin ganha o link da área de administração.
async function carregarUsuario() {
  try {
    const eu = await api('/eu');
    $('#quem').textContent = eu.nome;
    $('#link-admin').hidden = eu.papel !== 'admin';
  } catch { /* sessão expirada: o próprio api() redireciona */ }
}
$('#sair').addEventListener('click', async () => {
  await fetch('/api/publico/sair', { method: 'POST' });
  location.href = '/entrar.html';
});

carregarUsuario();
loadStatus();
loadCustos();
loadLastSearch();
loadActiveCampaign().then(restoreTab);
connect();
