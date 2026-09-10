const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const usd = (v) => 'US$ ' + Number(v ?? 0).toFixed(Number(v) < 1 ? 3 : 2).replace('.', ',');
const brl = (v) => 'R$ ' + (Number(v ?? 0) * 5.4).toFixed(2).replace('.', ',');
const data = (d) => (d ? new Date(d).toLocaleDateString('pt-BR') : '—');

const api = async (rota, opcoes = {}) => {
  const res = await fetch('/api' + rota, {
    headers: { 'Content-Type': 'application/json' },
    ...opcoes,
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });
  if (res.status === 401) return (location.href = '/entrar.html');
  if (res.status === 403) {
    document.body.innerHTML =
      '<div class="login-card" style="margin:70px auto"><h2>Área restrita</h2>' +
      '<p class="sub">Sua conta não é de administrador.</p><a class="btn accent full" href="/">Voltar ao painel</a></div>';
    throw new Error('sem permissão');
  }
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(dados.error || 'falha na requisição');
  return dados;
};

let toastTimer;
function toast(msg, erro = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (erro ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

$('#sair').addEventListener('click', async () => {
  await fetch('/api/publico/sair', { method: 'POST' });
  location.href = '/entrar.html';
});

async function carregar() {
  const eu = await api('/eu');
  $('#quem').textContent = `${eu.nome} · admin`;

  const p = await api('/admin/painel');

  // ── números do topo ──
  $('#totais').innerHTML = [
    ['usuários', p.totais.usuarios, `${p.totais.ativos} ativos`],
    ['gasto no mês', usd(p.totais.gastoMes), brl(p.totais.gastoMes)],
    ['ligações', p.totais.ligacoes, `${p.totais.atendidas} atenderam`],
    ['leads', p.totais.leads, `${p.totais.buscas} buscas`],
  ]
    .map(
      ([rotulo, valor, sub]) =>
        `<div class="stat"><span class="stat-num">${esc(valor)}</span>
         <span class="stat-lbl">${esc(rotulo)}</span>
         <span class="stat-sub">${esc(sub)}</span></div>`
    )
    .join('');

  // ── gráfico de barras (CSS puro, sem biblioteca) ──
  const maior = Math.max(...p.porDia.map((d) => d.usd), 0.0001);
  $('#pico').textContent = p.porDia.length ? `pico: ${usd(maior)}` : 'sem dados ainda';
  $('#grafico').innerHTML = p.porDia.length
    ? p.porDia
        .map((d) => {
          const altura = Math.max(3, Math.round((d.usd / maior) * 100));
          const dia = d.dia.slice(8) + '/' + d.dia.slice(5, 7);
          return `<div class="barra" title="${dia}: ${usd(d.usd)} em ${d.chamadas} chamadas">
                    <div class="barra-valor" style="height:${altura}%"></div>
                    <span>${dia}</span>
                  </div>`;
        })
        .join('')
    : '<div class="empty">Nenhum gasto registrado ainda.</div>';

  // ── tabela de usuários ──
  $('#qtd-usuarios').textContent = p.usuarios.length;
  $('#tabela-usuarios tbody').innerHTML = p.usuarios
    .map((u) => {
      const estourou = u.limite_usd && u.gasto_total >= u.limite_usd;
      const planoTag = u.plano
        ? `<span class="tag ${u.assinatura_status === 'ativa' ? 'ok' : 'hot'}">${esc(u.plano)} · ${esc(u.assinatura_status)}</span>`
        : '<span class="tag">sem plano</span>';
      const cotaTxt = u.plano
        ? `<div class="u-email">${u.buscas_ciclo ?? 0} buscas · ${u.ligacoes_ciclo ?? 0} ligações no ciclo</div>` +
          ((u.creditos_buscas || u.creditos_ligacoes)
            ? `<div class="u-email">+${u.creditos_buscas ?? 0} busca(s) · +${u.creditos_ligacoes ?? 0} ligação(ões) extra</div>`
            : '')
        : '';
      return `<tr data-id="${u.id}">
        <td>
          <div class="u-nome">${esc(u.nome)} ${u.papel === 'admin' ? '<span class="tag-tel">admin</span>' : ''}</div>
          <div class="u-email">${esc(u.email)} · desde ${data(u.created_at)}</div>
        </td>
        <td>${planoTag}${cotaTxt}</td>
        <td class="num">${usd(u.gasto_mes)}</td>
        <td class="num">${usd(u.gasto_total)}<div class="u-email">${brl(u.gasto_total)}</div></td>
        <td class="num ${estourou ? 'estourou' : ''}">${u.limite_usd ? usd(u.limite_usd) : '—'}</td>
        <td class="num">${u.buscas}</td>
        <td class="num">${u.leads}</td>
        <td class="num">${u.ligacoes}</td>
        <td class="num">${u.atendidas}</td>
        <td><span class="tag ${u.status === 'ativo' ? 'ok' : 'hot'}">${esc(u.status)}</span></td>
        <td class="acoes">
          <button class="link" data-acao="detalhe">ver</button>
          <button class="link" data-acao="plano">plano</button>
          <button class="link" data-acao="limite">limite</button>
          <button class="link" data-acao="status">${u.status === 'ativo' ? 'bloquear' : 'liberar'}</button>
        </td>
      </tr>`;
    })
    .join('');

  $('#tabela-tipos tbody').innerHTML = p.porTipo.length
    ? p.porTipo
        .map((t) => `<tr><td>${esc(t.tipo)}</td><td class="num">${t.chamadas}</td><td class="num">${usd(t.usd)}</td></tr>`)
        .join('')
    : '<tr><td colspan="3" class="empty">Nenhuma operação registrada.</td></tr>';

  ligarAcoes(p.usuarios);
}

function ligarAcoes(usuarios) {
  document.querySelectorAll('#tabela-usuarios [data-acao]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const linha = btn.closest('tr');
      const id = linha.dataset.id;
      const u = usuarios.find((x) => x.id === id);

      try {
        if (btn.dataset.acao === 'status') {
          const novo = u.status === 'ativo' ? 'bloqueado' : 'ativo';
          if (novo === 'bloqueado' && !confirm(`Bloquear ${u.nome}? Ele perde o acesso imediatamente.`)) return;
          await api('/admin/usuarios/' + id, { method: 'PATCH', body: { status: novo } });
          toast(`${u.nome}: ${novo}`);
          carregar();
        }

        if (btn.dataset.acao === 'limite') {
          const atual = u.limite_usd ?? '';
          const valor = prompt(
            `Limite de gasto para ${u.nome}, em dólares.\nDeixe vazio para não ter limite.\n\nGasto atual: ${usd(u.gasto_total)}`,
            atual
          );
          if (valor === null) return;
          await api('/admin/usuarios/' + id, { method: 'PATCH', body: { limiteUsd: valor.trim() || null } });
          toast('Limite atualizado.');
          carregar();
        }

        if (btn.dataset.acao === 'plano') {
          const planoAtual = u.plano || 'nenhum';
          const novoPlano = prompt(
            `Plano de ${u.nome}: basic, pro ou nenhum (para remover).\nAtual: ${planoAtual}`,
            planoAtual
          );
          if (novoPlano === null) return;
          const limpo = novoPlano.trim().toLowerCase();
          if (!['basic', 'pro', 'nenhum'].includes(limpo)) return toast('Digite basic, pro ou nenhum.', true);

          const corpo = { plano: limpo === 'nenhum' ? null : limpo };
          if (limpo !== 'nenhum') {
            corpo.assinaturaStatus = confirm('Marcar assinatura como ATIVA agora? (Cancelar = deixa como está)')
              ? 'ativa'
              : undefined;
          }
          await api('/admin/usuarios/' + id, { method: 'PATCH', body: corpo });
          toast('Plano atualizado.');
          carregar();
          return;
        }

        if (btn.dataset.acao === 'detalhe') mostrarDetalhe(id);
      } catch (err) {
        toast(err.message, true);
      }
    })
  );
}

async function mostrarDetalhe(id) {
  const d = await api('/admin/usuarios/' + id);
  $('#detalhe').hidden = false;
  $('#detalhe-titulo').textContent = `${d.usuario.nome} — ${d.usuario.email}`;
  $('#detalhe-corpo').innerHTML = `
    <div class="detalhe-linha">
      <b>${usd(d.totais.gasto)}</b> gastos em ${d.totais.chamadas} chamadas de IA ·
      <b>${d.totais.leads}</b> leads · último acesso ${data(d.usuario.ultimoAcesso)}
    </div>
    <h3>Buscas recentes</h3>
    ${
      d.buscas.length
        ? `<table class="tabela"><thead><tr><th>Segmento</th><th>Região</th><th>Qtd</th><th>Custo</th><th>Quando</th></tr></thead><tbody>` +
          d.buscas
            .map(
              (b) =>
                `<tr><td>${esc(b.segment)}</td><td>${esc(b.region)}</td><td class="num">${b.quantity}</td>` +
                `<td class="num">${b.custo_usd ? usd(b.custo_usd) : '—'}</td><td>${data(b.created_at)}</td></tr>`
            )
            .join('') +
          '</tbody></table>'
        : '<div class="empty">Nenhuma busca.</div>'
    }
    <h3>Campanhas recentes</h3>
    ${
      d.campanhas.length
        ? `<table class="tabela"><thead><tr><th>Campanha</th><th>Status</th><th>Ligações</th><th>Atenderam</th><th>Quando</th></tr></thead><tbody>` +
          d.campanhas
            .map(
              (c) =>
                `<tr><td>${esc(c.name)}</td><td>${esc(c.status)}</td><td class="num">${c.ligacoes}</td>` +
                `<td class="num">${c.atendidas}</td><td>${data(c.created_at)}</td></tr>`
            )
            .join('') +
          '</tbody></table>'
        : '<div class="empty">Nenhuma campanha.</div>'
    }`;
  $('#detalhe').scrollIntoView({ behavior: 'smooth' });
}

$('#fechar-detalhe').addEventListener('click', () => ($('#detalhe').hidden = true));

$('#novo-usuario').addEventListener('click', async () => {
  const nome = prompt('Nome do usuário:');
  if (!nome) return;
  const email = prompt('E-mail:');
  if (!email) return;
  const senha = prompt('Senha provisória (mínimo 6 caracteres):');
  if (!senha) return;
  try {
    await api('/admin/usuarios', { method: 'POST', body: { nome, email, senha } });
    toast('Usuário criado.');
    carregar();
  } catch (err) {
    toast(err.message, true);
  }
});

// ───────────────────────────────── backup / restauração
$('#arquivo-restaurar').addEventListener('change', async (e) => {
  const arquivo = e.target.files?.[0];
  e.target.value = ''; // permite escolher o mesmo arquivo de novo depois
  if (!arquivo) return;

  const confirmado = confirm(
    `Restaurar "${arquivo.name}"?\n\n` +
      'Isso substitui TODOS os dados atuais (usuários, leads, campanhas) pelos ' +
      'que estão dentro desse arquivo de backup, e reinicia o servidor.\n\n' +
      'Essa ação não pode ser desfeita.'
  );
  if (!confirmado) return;

  try {
    const base64 = await new Promise((resolve, reject) => {
      const leitor = new FileReader();
      leitor.onload = () => resolve(String(leitor.result));
      leitor.onerror = () => reject(new Error('não consegui ler o arquivo'));
      leitor.readAsDataURL(arquivo);
    });
    const r = await api('/admin/restaurar', { method: 'POST', body: { arquivo: base64 } });
    toast(r.aviso || 'Restaurando...');
    setTimeout(() => location.reload(), 9000);
  } catch (err) {
    toast(err.message, true);
  }
});

// ───────────────────────────────── saldo estimado da operação
async function carregarSaldo() {
  try {
    const s = await api('/admin/saldo');
    $('#saldo-twilio').textContent = s.twilio?.erro
      ? '—'
      : s.twilio
        ? `US$ ${Number(s.twilio.saldo).toFixed(2)}`
        : 'não configurado';
    if (s.twilio?.erro) $('#saldo-twilio').title = s.twilio.erro;

    if (!s.anthropic.configurado) {
      $('#saldo-anthropic').textContent = '—';
      $('#saldo-anthropic-detalhe').textContent = 'registre a última recarga abaixo para começar a estimar';
    } else {
      $('#saldo-anthropic').textContent = usd(s.anthropic.estimado);
      $('#saldo-anthropic-detalhe').textContent =
        `recarregou ${usd(s.anthropic.recarregado)} em ${data(s.anthropic.dataRecarga)} · ` +
        `gastou ${usd(s.anthropic.gastoDesde)} desde então`;
    }
  } catch (err) {
    toast('Saldo: ' + err.message, true);
  }
}

$('#registrar-recarga').addEventListener('click', async () => {
  const valor = Number($('#recarga-valor').value);
  if (!valor || valor <= 0) return toast('Informe o valor em dólares.', true);
  try {
    await api('/admin/saldo/anthropic', { method: 'POST', body: { valorUsd: valor } });
    $('#recarga-valor').value = '';
    toast('Recarga registrada.');
    carregarSaldo();
  } catch (err) {
    toast(err.message, true);
  }
});

// ───────────────────────────────── persistência (backup remoto)
async function carregarPersistencia() {
  try {
    const p = await api('/admin/persistencia');
    const el = $('#backup-remoto-status');
    if (!p.ativo) {
      el.textContent =
        'Backup remoto: DESLIGADO. Configure BACKUP_S3_* no .env para não perder dados se o volume falhar.';
      return;
    }
    $('#backup-agora').hidden = false;
    if (p.erro) {
      el.textContent = 'Backup remoto: ligado, mas com erro — ' + p.erro;
      return;
    }
    el.textContent = p.ultimo
      ? `Backup remoto: ligado · ${p.total} cópias · último em ${new Date(p.ultimo).toLocaleString('pt-BR')} (a cada ${p.intervaloMin} min)`
      : `Backup remoto: ligado · nenhuma cópia ainda (a cada ${p.intervaloMin} min)`;
  } catch { /* rota indisponivel */ }
}

$('#backup-agora').addEventListener('click', async () => {
  const btn = $('#backup-agora');
  btn.disabled = true;
  try {
    await api('/admin/persistencia/backup', { method: 'POST' });
    toast('Backup remoto enviado.');
    carregarPersistencia();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

carregar().catch((err) => toast(err.message, true));
carregarSaldo();
carregarPersistencia();
