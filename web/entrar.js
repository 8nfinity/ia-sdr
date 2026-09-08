const $ = (s) => document.querySelector(s);
let modo = 'login';

/** Sem nenhuma conta no sistema, a tela já abre em "criar conta". */
(async () => {
  try {
    const { temUsuarios, cadastroAberto } = await fetch('/api/publico/estado').then((r) => r.json());
    if (!temUsuarios) {
      $('#primeiro-acesso').hidden = false;
      $('#abas').hidden = true;
      trocarModo('cadastro');
      return;
    }
    // Cadastro fechado: some a aba em vez de deixar a pessoa preencher tudo
    // para só então descobrir que não pode criar conta.
    if (!cadastroAberto) {
      $('#abas').hidden = true;
      $('#aviso-fechado').hidden = false;
      trocarModo('login');
    }
  } catch {
    /* servidor ainda subindo */
  }
})();

function trocarModo(novo) {
  modo = novo;
  document.querySelectorAll('.aba').forEach((b) => b.classList.toggle('ativa', b.dataset.modo === novo));
  $('#campo-nome').hidden = novo !== 'cadastro';
  $('#nome').required = novo === 'cadastro';
  $('#senha').autocomplete = novo === 'cadastro' ? 'new-password' : 'current-password';
  $('#enviar').textContent = novo === 'cadastro' ? 'Criar conta' : 'Entrar';
  $('#erro').hidden = true;
}

document.querySelectorAll('.aba').forEach((b) => b.addEventListener('click', () => trocarModo(b.dataset.modo)));

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const erro = $('#erro');
  const botao = $('#enviar');
  erro.hidden = true;
  botao.disabled = true;

  try {
    const rota = modo === 'cadastro' ? '/api/publico/cadastro' : '/api/publico/login';
    const res = await fetch(rota, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nome: $('#nome').value,
        email: $('#email').value,
        senha: $('#senha').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'não foi possível continuar');
    location.href = '/';
  } catch (err) {
    erro.textContent = err.message;
    erro.hidden = false;
    botao.disabled = false;
  }
});
