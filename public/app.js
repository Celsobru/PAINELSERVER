/* Painel Server - front-end */
const BASE = location.pathname.replace(/\/(index\.html)?$/, '').replace(/\/$/, '');
const API = BASE + '/api';

const $ = (s) => document.querySelector(s);
const el = (id) => document.getElementById(id);
let currentView = 'dashboard';
let cache = { clients: [], sites: [], charges: [] };
let clientsSearch = '';
let qrTimer = null;

/* ---------- utils ---------- */
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function brl(cents) { return 'R$ ' + (Number(cents || 0) / 100).toFixed(2).replace('.', ','); }

function dateBR(d) {
  if (!d) return '-';
  const p = String(d).slice(0, 10).split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : d;
}
function tag(status) {
  const labels = { paid: 'Pago', pending: 'Pendente', overdue: 'Vencida', canceled: 'Cancelada' };
  return '<span class="tag ' + esc(status) + '">' + esc(labels[status] || status) + '</span>';
}
function toast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + (type || '');
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.className = 'toast hidden'; }, 4000);
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

const TOKEN_KEY = 'painelserver_token';
function api(path, method, body) {
  const token = localStorage.getItem('painelserver_token');
  return fetch(BASE + '/api/' + path, {
    method: method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    if (res.status === 401) { doLogout(); throw new Error('Sessão expirada. Entre novamente.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) throw new Error(data.message || 'Erro na requisição');
    return data;
  });
}

/* ---------- modal ---------- */
let modalHandler = null;
function openModal(title, fieldsHtml, submitLabel, onOk) {
  document.getElementById('modal-title').textContent = title;
  const form = document.getElementById('modal-form');
  form.innerHTML = '<div class="form-grid">' + fieldsHtml + '</div>' +
    '<div class="modal-actions"><button type="button" class="btn" id="modal-cancel">Cancelar</button>' +
    '<button type="submit" class="btn primary">' + (submitLabel || 'Salvar') + '</button></div>';
  document.getElementById('modal').classList.remove('hidden');
  modalSubmitHandler = onSubmit;
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const data = {};
    fd.forEach((v, k) => { data[k] = v; });
    try {
      await onSubmit(data);
      closeModal();
    } catch (e) { toast(e.message, 'err'); }
  };
  document.getElementById('modal-cancel').onclick = closeModal;
}
let modalSubmitHandler = null;
function closeModal() {
  document.getElementById('modal').classList.add('hidden');
  modalSubmitHandler = null;
}

/* ---------- auth ---------- */
function logout() {
  localStorage.removeItem('painelserver_token');
  document.getElementById('app-view').classList.add('hidden');
  document.getElementById('login-view').classList.remove('hidden');
}
document.getElementById('logout').onclick = logout;
document.getElementById('modal-close').onclick = closeModal;
document.getElementById('modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

document.getElementById('login-form').onsubmit = async (e) => {
  e.preventDefault();
  document.getElementById('login-error').textContent = '';
  try {
    const data = await apiCall('auth/login', 'POST', {
      email: document.getElementById('login-email').value,
      password: document.getElementById('login-password').value,
    });
    localStorage.setItem('painelserver_token', data.token);
    document.getElementById('who').textContent = data.name || data.email;
    showApp();
  } catch (err) {
    document.getElementById('login-error').textContent = err.message;
  }
};

async function apiCall(path, method, body) {
  const token = localStorage.getItem('painelserver_token');
  const res = await fetch(BASE + '/api/' + path, {
    method: method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { logout(); throw new Error('Sessão expirada'); }
  if (!res.ok || data.success === false) throw new Error(data.message || 'Erro na requisição');
  return data;
}

function showApp() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');
  navigate('dashboard');
}

/* ---------- navigation ---------- */
document.querySelectorAll('.sidebar nav a').forEach((a) => {
  a.onclick = () => navigate(a.dataset.view);
});
document.getElementById('refresh').onclick = () => navigate(currentView);

function navigate(view) {
  currentView = view;
  clearInterval(window._qrTimer);
  document.querySelectorAll('.sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  ['dashboard', 'clients', 'sites', 'charges', 'messages', 'settings'].forEach((v) => {
    document.getElementById('view-' + v).classList.toggle('hidden', v !== view);
  });
  const titles = { dashboard: 'Dashboard', clients: 'Clientes', sites: 'Sites no servidor', charges: 'Cobranças', messages: 'WhatsApp & Avisos', settings: 'Configurações' };
  document.getElementById('view-title').textContent = titles[view] || view;
  render(view).catch((e) => {
    document.getElementById('view-' + view).innerHTML = '<p class="error">Erro: ' + esc(e.message) + '</p>';
  });
}

async function render(view) {
  document.getElementById('view-' + view).innerHTML = '<p class="muted">Carregando...</p>';
  if (view === 'dashboard') return renderDashboard();
  if (view === 'clients') return renderClients();
  if (view === 'sites') return renderSites();
  if (view === 'charges') return renderCharges();
  if (view === 'messages') return renderMessages();
  if (view === 'settings') return renderSettings();
}

/* ---------- dashboard ---------- */
async function renderDashboard() {
  const d = await apiCall('dashboard');
  const t = d.totals;
  let box = '<div class="cards">' +
    card('Clientes ativos', t.clients) +
    card('Sites ativos', t.sites) +
    card('A receber', brl(t.pendingCents), 'yellow') +
    card('Vencidas', brl(t.overdueCents), 'red') +
    card('Recebido', brl(t.paidCents), 'green') +
    card('Total cobranças', t.charges) +
    '</div>';

  box += '<div class="panel-box"><h3>Últimas cobranças</h3><table><thead><tr><th>Cliente</th><th>Descrição</th><th>Valor</th><th>Vencimento</th><th>Status</th></tr></thead><tbody>';
  if (!d.recentCharges.length) box += '<tr><td colspan="5" class="muted">Nenhuma cobrança ainda.</td></tr>';
  d.recentCharges.forEach((c) => {
    box += '<tr><td>' + esc(c.client_name || '-') + '</td><td>' + esc(c.description) + '</td><td>' + brl(c.amount_cents) + '</td><td>' + dateBR(c.due_date) + '</td><td>' + tag(c.status) + '</td></tr>';
  });
  box += '</tbody></table></div>';

  box += '<div class="panel-box"><h3>Avisos recentes</h3><table><thead><tr><th>Cliente</th><th>Telefone</th><th>Status</th><th>Data</th></tr></thead><tbody>';
  if (!d.recentNotifications.length) box += '<tr><td colspan="4" class="muted">Nenhum aviso enviado.</td></tr>';
  d.recentNotifications.forEach((n) => {
    box += '<tr><td>' + esc(n.client_name || '-') + '</td><td>' + esc(n.destination) + '</td><td>' + esc(n.status) + '</td><td>' + esc(n.created_at || '') + '</td></tr>';
  });
  box += '</tbody></table></div>';
  document.getElementById('view-dashboard').innerHTML = box;
}
function card(label, value, cls) {
  return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value ' + (cls || '') + '">' + esc(value) + '</div></div>';
}

/* ---------- clients ---------- */
async function renderClients() {
  const q = searchTerm || '';
  const d = await apiCall('clients' + (q ? '?q=' + encodeURIComponent(q) : ''));
  cache.clients = d.clients;
  let box = '<div class="toolbar"><input id="client-search" placeholder="Buscar cliente..." value="' + esc(q) + '">' +
    '<button class="btn primary" id="client-new">+ Novo cliente</button></div>';
  box += '<div class="panel-box"><table><thead><tr><th>Nome</th><th>Empresa</th><th>Telefone</th><th>E-mail</th><th>Ações</th></tr></thead><tbody>';
  if (!d.clients.length) box += '<tr><td colspan="5" class="muted">Nenhum cliente cadastrado.</td></tr>';
  d.clients.forEach((c) => {
    box += '<tr><td>' + esc(c.name) + '</td><td>' + esc(c.company || '-') + '</td><td>' + esc(c.phone || '-') + '</td><td>' + esc(c.email || '-') + '</td>' +
      '<td class="row-actions">' +
      '<button class="btn sm" data-edit="' + c.id + '">Editar</button>' +
      '<button class="btn sm" data-charge="' + c.id + '">Cobrar</button>' +
      '<button class="btn sm red" data-del="' + c.id + '">Excluir</button></td></tr>';
  });
  box += '</tbody></table></div>';
  const root = document.getElementById('view-clients');
  root.innerHTML = box;
  root.querySelector('#client-search').oninput = debounce((e) => { searchTerm = e.target.value; render('clients').catch(() => {}); }, 400);
  root.querySelector('#client-new').onclick = () => clientForm(null);
  root.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => clientForm(cache.clients.find((x) => String(x.id) === b.dataset.edit)); });
  root.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => delClient(b.dataset.del); });
  root.querySelectorAll('[data-charge]').forEach((b) => { b.onclick = () => chargeForm(null, b.dataset.charge); });
}
let searchTerm = '';

function clientForm(c) {
  const f =
    field('Nome *', 'name', c ? c.name : '', true) +
    field('Empresa', 'company', c ? c.company : '') +
    '<div class="field"><label>Telefone (com DDD)</label><input name="phone" value="' + esc(c ? c.phone : '') + '" placeholder="14999999999"></div>' +
    field('E-mail', 'email', c ? c.email : '') +
    '<div class="field"><label>Documento (CPF/CNPJ)</label><input name="document" value="' + esc(c ? c.document : '') + '"></div>' +
    '<div class="field"><label>Observações</label><textarea name="notes" rows="2">' + esc(c ? c.notes : '') + '</textarea></div>';
  openModal(c ? 'Editar cliente' : 'Novo cliente', f, 'Salvar', async (data) => {
    if (c) await apiCall('clients/' + c.id, 'PUT', data);
    else await apiCall('clients', 'POST', data);
    toast('Cliente salvo!', 'ok');
    searchTerm = searchTerm; // mantém
    await render('clients');
  });
}
function field(label, name, value, required) {
  return '<div class="field"><label>' + esc(label) + '</label><input name="' + name + '" value="' + esc(value || '') + '"' + (required ? ' required' : '') + '></div>';
}
async function delClient(id) {
  if (!confirm('Excluir este cliente?')) return;
  await apiCall('clients/' + id, 'DELETE');
  await render('clients');
}

/* ---------- charges ---------- */
let chargeFilter = '';
async function renderCharges() {
  const d = await apiCall('charges' + (chargeFilter ? '?status=' + chargeFilter : ''));
  cache.charges = d.charges;
  const clients = cache.clients.length ? cache.clients : (await apiCall('clients')).clients;
  cache.clients = clients;
  let box = '<div class="toolbar">' +
    '<select id="charge-filter"><option value="">Todas</option><option value="pending">Pendentes</option><option value="overdue">Vencidas</option><option value="paid">Pagas</option></select>' +
    '<button class="btn primary" id="charge-new">+ Nova cobrança</button>' +
    '<button class="btn" id="charge-remind">Avisar pendentes no WhatsApp</button></div>';
  box += '<div class="panel-box"><table><thead><tr><th>Cliente</th><th>Descrição</th><th>Valor</th><th>Vencimento</th><th>Tipo</th><th>Status</th><th>Ações</th></tr></thead><tbody>';
  if (!d.charges.length) box += '<tr><td colspan="7" class="muted">Nenhuma cobrança.</td></tr>';
  d.charges.forEach((c) => {
    box += '<tr><td>' + esc(c.client_name || '-') + '</td><td>' + esc(c.description) + '</td><td>' + brl(c.amount_cents) + '</td><td>' + dateBR(c.due_date) + '</td><td>' + esc(c.type || 'avulsa') + '</td><td>' + tag(c.status) + '</td>' +
      '<td class="row-actions">' +
      (c.status !== 'paid' ? '<button class="btn sm green" data-pay="' + c.id + '">Baixa</button>' : '') +
      (c.status !== 'paid' && c.status !== 'canceled' ? '<button class="btn sm" data-wa="' + c.id + '">Cobrar</button>' : '') +
      '<button class="btn sm" data-edit="' + c.id + '">Editar</button>' +
      '<button class="btn sm red" data-del="' + c.id + '">Excluir</button></td></tr>';
  });
  box += '</tbody></table></div>';
  const root = document.getElementById('view-charges');
  root.innerHTML = box;
  root.querySelector('#charge-filter').value = chargeFilter;
  root.querySelector('#charge-filter').onchange = (e) => { chargeFilter = e.target.value; render('charges'); };
  root.querySelector('#charge-new').onclick = () => chargeForm(null, null);
  root.querySelector('#charge-remind').onclick = async () => {
    if (!confirm('Enviar cobrança no WhatsApp para TODOS os pendentes?')) return;
    const r = await apiCall('notifications/remind-overdue', 'POST', {});
    toast('Enviados: ' + r.sent + ' | Falhas: ' + r.failed, r.failed ? 'err' : 'ok');
  };
  root.querySelectorAll('[data-pay]').forEach((b) => b.onclick = () => payCharge(b.dataset.pay));
  root.querySelectorAll('[data-wa]').forEach((b) => b.onclick = () => sendChargeWA(b.dataset.wa));
  root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => chargeForm(cache.charges.find((x) => x.id == b.dataset.edit), null));
  root.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => { if (confirm('Excluir cobrança?')) { await apiCall('charges/' + b.dataset.del, 'DELETE'); render('charges'); } });
}
function clientOptions(selected) {
  return cache.clients.map((c) => '<option value="' + c.id + '"' + (selected == c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');
}
function chargeForm(c, presetClientId) {
  const clientSel = '<div class="field"><label>Cliente</label><select name="client_id">' +
    '<option value="">-- selecione --</option>' + clientOptions(c ? c.client_id : presetClientId) + '</select></div>';
  const amount = c ? (c.amount_cents / 100).toFixed(2) : '';
  const f = clientSel +
    '<div class="field"><label>Descrição *</label><input name="description" value="' + esc(c ? c.description : '') + '" required placeholder="Ex: Mensalidade site - Novembro"></div>' +
    '<div class="field"><label>Valor (R$) *</label><input name="amount" value="' + esc(amount) + '" required placeholder="150.00"></div>' +
    '<div class="field"><label>Vencimento</label><input type="date" name="due_date" value="' + esc(c ? (c.due_date || '') : '') + '"></div>' +
    '<div class="field"><label>Tipo</label><select name="type"><option value="avulsa"' + (c && c.type === 'avulsa' ? ' selected' : '') + '>Avulsa</option><option value="recorrente"' + (c && c.type === 'recorrente' ? ' selected' : '') + '>Recorrente</option></select></div>' +
    '<div class="field"><label>Forma</label><select name="method"><option value="pix"' + (c && c.method === 'pix' ? ' selected' : '') + '>Pix</option><option value="boleto"' + (c && c.method === 'boleto' ? ' selected' : '') + '>Boleto</option><option value="card"' + (c && c.method === 'card' ? ' selected' : '') + '>Cartão</option><option value="manual"' + (c && c.method === 'manual' ? ' selected' : '') + '>Manual</option></select></div>';
  openModal(c ? 'Editar cobrança' : 'Nova cobrança', f, 'Salvar', async (data) => {
    data.amount_cents = Math.round(Number(data.amount || 0) * 100);
    data.client_id = data.client_id || null;
    if (c) await apiCall('charges/' + c.id, 'PUT', data);
    else await apiCall('charges', 'POST', data);
    toast('Cobrança salva!', 'ok');
    await render('charges');
  });
}
async function payCharge(id) {
  if (!confirm('Confirmar o recebimento desta cobrança?')) return;
  await apiCall('charges/' + id + '/pay', 'POST', {});
  toast('Baixa registrada!', 'ok');
  await render('charges');
}
async function sendChargeWA(id) {
  try {
    const r = await apiCall('notifications/charge/' + id, 'POST', {});
    toast('Cobrança enviada no WhatsApp!', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------- sites ---------- */
async function renderSites() {
  const [sites, st] = await Promise.all([apiCall('sites'), apiCall('sites/status')]);
  cache.sites = sites.sites;
  let box = '<div class="toolbar"><button class="btn primary" id="site-new">+ Novo site</button></div>';
  box += '<div class="panel-box"><h3>Apps no PM2</h3><table><thead><tr><th>Nome</th><th>Status</th><th>CPU</th><th>Memória</th><th>Reinícios</th><th>Ações</th></tr></thead><tbody>';
  if (!st.pm2 || !st.pm2.length) box += '<tr><td colspan="6" class="muted">PM2 indisponível.</td></tr>';
  (st.pm2 || []).forEach((p) => {
    box += '<tr><td><b>' + esc(p.name) + '</b>' + (p.site ? ' <span class="muted">' + esc(p.site.domain || '') + '</span>' : '') + '</td>' +
      '<td><span class="status-pill"><span class="dot ' + (p.status === 'online' ? 'ready' : 'error') + '"></span>' + esc(p.status) + '</span></td>' +
      '<td>' + Number(p.cpu || 0).toFixed(1) + '%</td><td>' + Math.round((p.memory || 0) / 1048576) + ' MB</td><td>' + (p.restarts || 0) + '</td>' +
      '<td class="row-actions"><button class="btn sm" data-pm2="' + esc(p.name) + '" data-action="restart">Reiniciar</button>' +
      '<button class="btn sm red" data-pm2="' + esc(p.name) + '" data-action="stop">Parar</button>' +
      '<button class="btn sm green" data-pm2="' + esc(p.name) + '" data-action="start">Iniciar</button></td></tr>';
  });
  box += '</tbody></table></div>';

  box += '<div class="panel-box"><h3>Sites cadastrados</h3><table><thead><tr><th>Nome</th><th>Domínio</th><th>Porta</th><th>PM2</th><th>Cliente</th><th>Ações</th></tr></thead><tbody>';
  if (!sites.sites.length) box += '<tr><td colspan="6" class="muted">Nenhum site cadastrado.</td></tr>';
  sites.sites.forEach((s) => {
    box += '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.domain || '-') + '</td><td>' + esc(s.port || '-') + '</td><td>' + esc(s.pm2_name || '-') + '</td><td>' + esc(s.client_name || '-') + '</td>' +
      '<td class="row-actions"><button class="btn sm" data-site-edit="' + s.id + '">Editar</button><button class="btn sm red" data-site-del="' + s.id + '">Excluir</button></td></tr>';
  });
  box += '</tbody></table></div>';
  const root = document.getElementById('view-sites');
  root.innerHTML = box;
  root.querySelector('#site-new').onclick = () => siteForm(null);
  root.querySelectorAll('[data-pm2]').forEach((b) => b.onclick = async () => {
    if (!confirm(b.dataset.action + ' ' + b.dataset.pm2 + '?')) return;
    try {
      await apiCall('sites/pm2/' + encodeURIComponent(b.dataset.pm2) + '/' + b.dataset.action, 'POST', {});
      toast('OK: ' + b.dataset.action + ' ' + b.dataset.pm2, 'ok');
    } catch (e) { toast(e.message, 'err'); }
    render('sites');
  });
  root.querySelectorAll('[data-site-edit]').forEach((b) => b.onclick = () => siteForm(cache.sites.find((x) => x.id == b.dataset.siteEdit)));
  root.querySelectorAll('[data-site-del]').forEach((b) => b.onclick = async () => { if (confirm('Excluir site?')) { await apiCall('sites/' + b.dataset.siteDel, 'DELETE'); render('sites'); } });
}
function siteForm(s) {
  const f = '<div class="field"><label>Nome *</label><input name="name" value="' + esc(s ? s.name : '') + '" required></div>' +
    '<div class="field"><label>Domínio</label><input name="domain" value="' + esc(s ? s.domain : '') + '" placeholder="exemplo.com.br"></div>' +
    '<div class="field"><label>Porta</label><input name="port" value="' + esc(s ? s.port : '') + '"></div>' +
    '<div class="field"><label>Nome no PM2</label><input name="pm2_name" value="' + esc(s ? s.pm2_name : '') + '" placeholder="meuapp"></div>' +
    '<div class="field"><label>Repositório</label><input name="repo" value="' + esc(s ? s.repo : '') + '"></div>' +
    '<div class="field"><label>Cliente</label><select name="client_id"><option value="">-- nenhum --</option>' + clientOptions(s ? s.client_id : null) + '</select></div>';
  openModal(s ? 'Editar site' : 'Novo site', f, 'Salvar', async (data) => {
    data.client_id = data.client_id || null;
    data.port = data.port ? Number(data.port) : null;
    if (s) await apiCall('sites/' + s.id, 'PUT', data);
    else await apiCall('sites', 'POST', data);
    toast('Site salvo!', 'ok');
    await render('sites');
  });
}

/* ---------- messages (whatsapp) ---------- */
async function renderMessages() {
  const tpl = await apiCall('notifications/templates');
  cache.templates = tpl.templates;
  let box = '<div class="panel-box"><h3>Status do WhatsApp</h3><div id="wa-status" class="muted">Carregando...</div>' +
    '<div id="wa-qr" class="qr-box"></div>' +
    '<div class="toolbar" style="margin-top:12px">' +
    '<button class="btn" id="wa-refresh">Atualizar</button>' +
    '<button class="btn red" id="wa-logout">Desconectar (nova sessão)</button></div>' +
    '<div class="field" style="margin-top:10px"><label>Enviar teste para (com DDD)</label>' +
    '<div class="toolbar"><input id="wa-test-phone" placeholder="14999999999" style="max-width:220px">' +
    '<button class="btn primary" id="wa-test">Enviar teste</button></div></div></div>';

  box += '<div class="panel-box"><h3>Modelos de mensagem</h3>' +
    '<div class="field"><label>Cobrança (variáveis: {cliente} {descricao} {valor} {vencimento})</label>' +
    '<textarea id="tpl-charge" rows="5">' + esc(cache.templates.tpl_charge || '') + '</textarea></div>' +
    '<div class="field"><label>Pagamento recebido (variáveis: {cliente})</label>' +
    '<textarea id="tpl-paid" rows="3">' + esc(cache.templates.tpl_paid || '') + '</textarea></div>' +
    '<button class="btn primary" id="tpl-save">Salvar modelos</button></div>';

  document.getElementById('view-messages').innerHTML = box;
  document.getElementById('wa-refresh').onclick = () => refreshWa();
  document.getElementById('wa-logout').onclick = async () => { if (confirm('Apagar a sessão atual do WhatsApp?')) { await apiCall('whatsapp/logout', 'POST', {}); toast('Sessão apagada.', 'ok'); render('messages'); } };
  document.getElementById('wa-test').onclick = async () => {
    try { await apiCall('whatsapp/test', 'POST', { phone: document.getElementById('wa-test-phone').value }); toast('Teste enviado!', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  document.getElementById('tpl-save').onclick = async () => {
    await apiCall('notifications/templates', 'PUT', { tpl_charge: document.getElementById('tpl-charge').value, tpl_paid: document.getElementById('tpl-paid').value });
    toast('Modelos salvos!', 'ok');
  };
  refreshWa();
  window._qrTimer = setInterval(refreshWa, 5000);
}
async function refreshWa() {
  try {
    const s = await apiCall('whatsapp');
    const st = document.getElementById('wa-status');
    if (!st) { clearInterval(window._qrTimer); return; }
    const labels = { ready: 'Conectado', qr: 'Aguardando leitura do QR Code', initializing: 'Iniciando...', stopped: 'Parado', disconnected: 'Desconectado', error: 'Erro' };
    st.innerHTML = '<span class="status-pill"><span class="dot ' + esc(s.status) + '"></span>' + esc(labels[s.status] || s.status) + '</span>' +
      (s.phoneNumber ? ' <span class="muted">(' + esc(s.phoneNumber) + ')</span>' : '') +
      (s.error ? '<div class="error">' + esc(s.error).slice(0, 300) + '</div>' : '');
    const qr = document.getElementById('wa-qr');
    if (s.qrCode) {
      qr.innerHTML = '<p class="muted" style="margin-bottom:10px">Abra o WhatsApp → Aparelhos conectados → Conectar aparelho</p><img src="' + s.qrCode + '">';
    } else {
      qr.innerHTML = '';
    }
  } catch (e) { clearInterval(window._qrTimer); }
}

/* ---------- settings ---------- */
async function renderSettings() {
  const me = await apiCall('auth/me');
  const box = '<div class="panel-box"><h3>Minha conta</h3>' +
    '<p class="muted">' + esc(me.admin.name) + ' — ' + esc(me.admin.email) + '</p>' +
    '<div class="field"><label>Senha atual</label><input type="password" id="pw-current"></div>' +
    '<div class="field"><label>Nova senha (mín. 6)</label><input type="password" id="pw-new"></div>' +
    '<button class="btn primary" id="pw-save">Alterar senha</button></div>' +
    '<div class="panel-box"><h3>Sobre</h3><p class="muted">Painel Server v1.0 — gestão de sites, clientes, cobranças e avisos via WhatsApp.<br>' +
    'Avisos por e-mail: desativados (somente WhatsApp por enquanto).<br>Gateway de pagamento: pronto para integração (Mercado Pago via webhook).</p></div>';
  document.getElementById('view-settings').innerHTML = box;
  document.getElementById('pw-save').onclick = async () => {
    try {
      await apiCall('auth/change-password', 'POST', { current_password: document.getElementById('pw-current').value, new_password: document.getElementById('pw-new').value });
      toast('Senha alterada!', 'ok');
      document.getElementById('pw-current').value = '';
      document.getElementById('pw-new').value = '';
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------- boot ---------- */
if (localStorage.getItem('painelserver_token')) {
  apiCall('auth/me').then((me) => {
    document.getElementById('who').textContent = me.admin.name || me.admin.email;
    showApp();
  }).catch(() => logout());
}
