const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const brl = (centavos) => 'R$ ' + (centavos / 100).toFixed(2).replace('.', ',');

const api = async (path, options = {}) => {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) return (location.href = '/entrar.html');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'falha na requisição'), { dados: data });
  return data;
};

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

$('#sair').addEventListener('click', async () => {
  await fetch('/api/publico/sair', { method: 'POST' });
  location.href = '/entrar.html';
});

const state = { planos: [], creditos: [], publicKey: '', ficha: null, mp: null, camposMontados: false, acao: null };

async function carregar() {
  const eu = await api('/eu');
  $('#quem').textContent = eu.nome;

  const dados = await api('/pagamentos/planos');
  state.planos = dados.planos;
  state.creditos = dados.creditos;
  state.publicKey = dados.publicKey;
  $('#sem-mp').hidden = dados.configurado;

  state.ficha = await api('/pagamentos/status');

  renderStatus();
  renderPlanos();
  renderCreditos();

  if (dados.configurado && window.MercadoPago && !state.mp) {
    state.mp = new MercadoPago(state.publicKey);
  }
}

function renderStatus() {
  const f = state.ficha;
  const box = $('#status-atual');
  if (!f?.plano) { box.hidden = true; return; }
  box.hidden = false;
  $('#status-plano-nome').textContent = 'Plano ' + f.plano.nome;
  const tag = $('#status-tag');
  const ok = f.assinaturaStatus === 'ativa';
  tag.textContent = ok ? 'ativa' : f.assinaturaStatus;
  tag.classList.toggle('good', ok);

  const barra = (rotulo, usado, total, extra) => `
    <div>
      <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--muted);margin-bottom:5px">
        <span>${rotulo}</span><span>${usado} de ${total}${extra ? ` <span style="color:var(--accent)">+${extra} crédito${extra > 1 ? 's' : ''}</span>` : ''}</span>
      </div>
      <div class="lead-bar"><div style="width:${Math.min(100, Math.round((usado / Math.max(1, total)) * 100))}%"></div></div>
    </div>`;
  $('#status-barras').innerHTML =
    barra('Buscas neste ciclo', f.usoCiclo.buscas, f.plano.buscasMes, f.creditosBuscas) +
    barra('Ligações neste ciclo', f.usoCiclo.ligacoes, f.plano.ligacoesMes, f.creditosLigacoes) +
    (f.periodoFim
      ? `<span style="font-size:12px;color:var(--muted-3)">Renova em ${new Date(f.periodoFim).toLocaleDateString('pt-BR')}</span>`
      : '');
}

function renderPlanos() {
  const atual = state.ficha?.plano?.id;
  const ativa = state.ficha?.assinaturaStatus === 'ativa';
  $('#planos-cards').innerHTML = state.planos
    .map((p) => {
      const meuPlano = atual === p.id && ativa;
      return `<div class="crm-card">
        <div class="crm-card-head">
          <span class="id-badge"><span class="crm-icon">${esc(p.nome.slice(0, 2).toUpperCase())}</span><span class="crm-rotulo">${esc(p.nome)}</span></span>
          ${meuPlano ? '<span class="tag ok">plano atual</span>' : ''}
        </div>
        <div style="font:700 28px/1.2 var(--font-head);color:var(--heading)">${brl(p.precoCentavos)}<span style="font-size:13px;color:var(--muted);font-weight:500">/mês</span></div>
        <div class="crm-campos" style="margin:6px 0">
          <div class="campo" style="text-transform:none;letter-spacing:0;font-size:13.5px;color:var(--text)">✓ ${p.buscasMes} buscas de até 10 leads/mês</div>
          <div class="campo" style="text-transform:none;letter-spacing:0;font-size:13.5px;color:var(--text)">✓ ${p.ligacoesMes} ligações/mês</div>
        </div>
        <button class="btn ${meuPlano ? 'ghost' : 'accent'} assinar-btn" data-plano="${p.id}" ${meuPlano ? 'disabled' : ''}>
          ${meuPlano ? 'Seu plano atual' : atual ? 'Trocar para este' : 'Assinar'}
        </button>
      </div>`;
    })
    .join('');
  document.querySelectorAll('.assinar-btn').forEach((btn) =>
    btn.addEventListener('click', () => abrirCheckout({ tipo: 'assinar', planoId: btn.dataset.plano }))
  );
}

function renderCreditos() {
  const secao = $('#creditos-secao');
  const ativa = state.ficha?.assinaturaStatus === 'ativa';
  secao.hidden = !ativa;
  if (!ativa) return;
  $('#creditos-cards').innerHTML = state.creditos
    .map(
      (c) => `<div class="crm-card">
        <div class="crm-card-head">
          <span class="crm-rotulo">${esc(c.rotulo)}</span>
        </div>
        <div style="font:700 22px/1.2 var(--font-head);color:var(--heading)">${brl(c.precoCentavos)}</div>
        <span class="crm-info">Não expira - fica disponível até você usar.</span>
        <button class="btn accent comprar-btn" data-tipo="${c.id}">Comprar</button>
      </div>`
    )
    .join('');
  document.querySelectorAll('.comprar-btn').forEach((btn) =>
    btn.addEventListener('click', () => abrirCheckout({ tipo: 'credito', creditoId: btn.dataset.tipo }))
  );
}

// ───────────────────────────────── checkout (Secure Fields do Mercado Pago)
function montarCampos() {
  if (state.camposMontados || !state.mp) return;
  state.mp.fields.create('cardNumber', { placeholder: '0000 0000 0000 0000' }).mount('cardNumber');
  state.mp.fields.create('expirationDate', { placeholder: 'MM/AA' }).mount('cardExpirationDate');
  state.mp.fields.create('securityCode', { placeholder: 'CVV' }).mount('securityCode');
  state.camposMontados = true;
}

function abrirCheckout(acao) {
  if (!state.mp) return toast('Pagamentos não configurados neste servidor.', true);
  state.acao = acao;
  const plano = acao.tipo === 'assinar' ? state.planos.find((p) => p.id === acao.planoId) : null;
  const credito = acao.tipo === 'credito' ? state.creditos.find((c) => c.id === acao.creditoId) : null;
  $('#checkout-titulo').textContent =
    acao.tipo === 'assinar' ? `Assinar ${plano.nome} — ${brl(plano.precoCentavos)}/mês` : `${credito.rotulo} — ${brl(credito.precoCentavos)}`;
  $('#checkout').hidden = false;
  $('#checkout').scrollIntoView({ behavior: 'smooth' });
  montarCampos();
}

$('#checkout-fechar').addEventListener('click', () => ($('#checkout').hidden = true));

$('#checkout-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#checkout-enviar');
  const erroBox = $('#checkout-erro');
  erroBox.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Processando...';

  try {
    const token = await state.mp.fields.createCardToken({
      cardholderName: $('#cardholderName').value.trim(),
      identificationType: $('#docType').value,
      identificationNumber: $('#docNumber').value.trim(),
    });
    if (!token?.id) throw new Error('Não consegui validar o cartão. Confira os dados.');

    const eu = await api('/eu');
    const corpo =
      state.acao.tipo === 'assinar'
        ? { plano: state.acao.planoId, cardTokenId: token.id, email: eu.email }
        : { tipo: state.acao.creditoId, cardTokenId: token.id, email: eu.email };
    const rota = state.acao.tipo === 'assinar' ? '/pagamentos/assinar' : '/pagamentos/creditos';

    const r = await api(rota, { method: 'POST', body: corpo });
    toast(r.aviso || 'Pagamento confirmado!');
    $('#checkout').hidden = true;
    $('#checkout-form').reset();
    await carregar();
  } catch (err) {
    erroBox.hidden = false;
    erroBox.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirmar pagamento';
  }
});

$('#cancelar-assinatura').addEventListener('click', async () => {
  if (!confirm('Cancelar sua assinatura? Você perde acesso a novas buscas e ligações quando o ciclo atual terminar.')) return;
  try {
    await api('/pagamentos/cancelar', { method: 'POST' });
    toast('Assinatura cancelada.');
    await carregar();
  } catch (err) {
    toast(err.message, true);
  }
});

carregar().catch((err) => toast(err.message, true));
