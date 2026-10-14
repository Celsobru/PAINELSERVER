const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'painelserver.db');
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      // Expoe id/lastID/changes de forma consistente para todos os chamadores.
      resolve({ id: this.lastID, lastID: this.lastID, changes: this.changes });
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function init() {
  await run('PRAGMA foreign_keys = ON');

  await run(`CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  await run(`CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    company TEXT,
    email TEXT,
    phone TEXT,
    document TEXT,
    notes TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  await run(`CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    client_id INTEGER,
    domain TEXT,
    port INTEGER,
    pm2_name TEXT,
    repo TEXT,
    active INTEGER DEFAULT 1,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE SET NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS charges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    description TEXT NOT NULL,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    method TEXT DEFAULT 'pix',
    type TEXT DEFAULT 'avulsa',
    recurrence TEXT,
    gateway TEXT,
    gateway_id TEXT,
    paid_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE SET NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    charge_id INTEGER,
    channel TEXT NOT NULL DEFAULT 'whatsapp',
    destination TEXT,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  // Migracoes idempotentes: colunas de cobranca Pix + controle de lembretes
  const chargeCols = [
    'txid TEXT',
    'pix_copia_cola TEXT',
    'pix_location TEXT',
    'last_notified_at TEXT',
    'notify_count INTEGER DEFAULT 0',
    'paid_via TEXT',
  ];
  for (const col of chargeCols) {
    try { await run('ALTER TABLE charges ADD COLUMN ' + col); } catch (e) { /* coluna ja existe */ }
  }

  // Configuracoes da cobranca automatica (defaults; nao sobrescreve o que ja existe)
  const cfgDefaults = {
    pix_key: '',
    pix_receiver_name: '',
    pix_city: '',
    reminder_enabled: 'false',
    reminder_hour: '9',
  };
  for (const k of Object.keys(cfgDefaults)) {
    const row = await get('SELECT value FROM settings WHERE key = ?', [k]);
    if (!row) await run('INSERT INTO settings (key, value) VALUES (?, ?)', [k, cfgDefaults[k]]);
  }

  // Admin inicial
  const email = (process.env.ADMIN_EMAIL || 'admin@visionhubweb.com.br').toLowerCase();
  const existing = await get('SELECT id FROM admins WHERE email = ?', [email]);
  if (!existing) {
    let pass = process.env.ADMIN_PASSWORD;
    let gerada = false;
    if (!pass) {
      pass = require('crypto').randomBytes(12).toString('base64url');
      gerada = true;
    }
    const name = process.env.ADMIN_NAME || 'Administrador';
    await run('INSERT INTO admins (name, email, password) VALUES (?, ?, ?)', [name, email, bcrypt.hashSync(pass, 10)]);
    console.log('[db] Admin criado: ' + email + (gerada ? ' | SENHA GERADA (guarde agora): ' + pass : ''));
  }

  // Templates de aviso (editaveis no painel)
  const tpl = await get('SELECT value FROM settings WHERE key = ?', ['tpl_charge']);
  if (!tpl) {
    await run('INSERT INTO settings (key, value) VALUES (?, ?)', ['tpl_charge',
      'Ola {cliente}! 👋\n\nPassando para lembrar da sua cobranca:\n\n*Servico:* {descricao}\n*Valor:* {valor}\n*Vencimento:* {vencimento}\n\nQualquer duvida estou a disposicao!']);
  }
  const tplPaid = await get('SELECT value FROM settings WHERE key = ?', ['tpl_paid']);
  if (!tplPaid) {
    await run('INSERT INTO settings (key, value) VALUES (?, ?)', ['tpl_paid',
      'Recebemos seu pagamento, {cliente}! ✅\n\nObrigado pela confianca! 🙏']);
  }

  console.log('[db] Banco pronto em ' + dbPath);
}

module.exports = { db, run, get, all, init };
