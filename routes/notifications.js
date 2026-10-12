const express = require('express');
const { all, get, run } = require('../db');
const { authenticate } = require('./auth');
const whatsapp = require('../whatsapp');

const router = express.Router();
router.use(authenticate);

function formatBRL(cents) {
  return 'R$ ' + (Number(cents || 0) / 100).toFixed(2).replace('.', ',');
}
function formatDate(d) {
  if (!d) return '-';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return day + '/' + m + '/' + y;
}
function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''));
}

router.get('/', async (req, res) => {
  const rows = await all(`SELECT n.*, c.name AS client_name FROM notifications n LEFT JOIN clients c ON c.id = n.client_id ORDER BY n.id DESC LIMIT 200`);
  res.json({ success: true, notifications: rows });
});

async function sendAndLog({ client_id, charge_id, phone, message }) {
  let status = 'queued';
  let error = null;
  try {
    await whatsapp.sendMessage(phone, message);
    status = 'sent';
  } catch (e) {
    status = 'failed';
    error = e.message || String(e);
  }
  const r = await run(
    "INSERT INTO notifications (client_id, charge_id, channel, destination, message, status, error, sent_at) VALUES (?,?, 'whatsapp', ?,?,?,?, CASE WHEN ? = 'sent' THEN datetime('now') ELSE NULL END)",
    [client_id || null, charge_id || null, phone, message, status, error, status]
  );
  return { id: r.id, status, error };
}

// Enviar cobranca (usa template tpl_charge, com placeholders)
router.post('/charge/:id', async (req, res) => {
  const ch = await get('SELECT ch.*, c.name AS client_name, c.phone AS client_phone FROM charges ch LEFT JOIN clients c ON c.id = ch.client_id WHERE ch.id = ?', [req.params.id]);
  if (!ch) return res.status(404).json({ success: false, message: 'Cobranca nao encontrada.' });
  const phone = (req.body && req.body.phone) || ch.client_phone;
  if (!phone) return res.status(400).json({ success: false, message: 'Cliente sem telefone cadastrado.' });
  const tplRow = await get('SELECT value FROM settings WHERE key = ?', ['tpl_charge']);
  const message = (req.body && req.body.message) || fillTemplate(tplRow && tplRow.value, {
    cliente: ch.client_name || 'cliente',
    descricao: ch.description,
    valor: formatBRL(ch.amount_cents),
    vencimento: formatDate(ch.due_date),
  });
  const out = await sendAndLog({ client_id: ch.client_id, charge_id: ch.id, phone, message });
  res.json({ success: out.status === 'sent', status: out.status, error: out.error });
});

// Enviar aviso de pagamento recebido
router.post('/paid/:id', async (req, res) => {
  const ch = await get('SELECT ch.*, c.name AS client_name, c.phone AS client_phone FROM charges ch LEFT JOIN clients c ON c.id = ch.client_id WHERE ch.id = ?', [req.params.id]);
  if (!ch) return res.status(404).json({ success: false, message: 'Cobranca nao encontrada.' });
  const phone = (req.body && req.body.phone) || ch.client_phone;
  if (!phone) return res.status(400).json({ success: false, message: 'Cliente sem telefone cadastrado.' });
  const tplRow = await get('SELECT value FROM settings WHERE key = ?', ['tpl_paid']);
  const message = (req.body && req.body.message) || fillTemplate(tplRow && tplRow.value, {
    cliente: ch.client_name || 'cliente',
    valor: formatBRL(ch.amount_cents),
    descricao: ch.description,
  });
  const out = await sendAndLog({ client_id: ch.client_id, charge_id: ch.id, phone, message });
  res.json({ success: out.status === 'sent', status: out.status, error: out.error });
});

// Envio avulso
router.post('/send', async (req, res) => {
  const { phone, message, client_id } = req.body || {};
  if (!phone || !message) return res.status(400).json({ success: false, message: 'Informe telefone e mensagem.' });
  const out = await sendAndLog({ client_id: client_id || null, charge_id: null, phone, message });
  res.json({ success: out.status === 'sent', status: out.status, error: out.error });
});

// Disparo em massa dos vencidos/pendentes
router.post('/remind-overdue', async (req, res) => {
  const rows = await all(`SELECT ch.*, c.name AS client_name, c.phone AS client_phone
    FROM charges ch LEFT JOIN clients c ON c.id = ch.client_id
    WHERE ch.status = 'pending' AND c.phone IS NOT NULL AND c.phone != ''`);
  const tplRow = await get('SELECT value FROM settings WHERE key = ?', ['tpl_charge']);
  let sent = 0, failed = 0;
  for (const ch of rows) {
    const message = fillTemplate(tplRow && tplRow.value, {
      cliente: ch.client_name || 'cliente',
      descricao: ch.description,
      valor: formatBRL(ch.amount_cents),
      vencimento: formatDate(ch.due_date),
    });
    const out = await sendAndLog({ client_id: ch.client_id, charge_id: ch.id, phone: ch.client_phone, message });
    if (out.status === 'sent') sent++; else failed++;
  }
  res.json({ success: true, total: rows.length, sent, failed });
});

// Templates
router.get('/templates', async (req, res) => {
  const rows = await all("SELECT key, value FROM settings WHERE key LIKE 'tpl_%'");
  const map = {};
  rows.forEach((r) => { map[r.key] = r.value; });
  res.json({ success: true, templates: map });
});

router.put('/templates', async (req, res) => {
  const b = req.body || {};
  for (const k of ['tpl_charge', 'tpl_paid']) {
    if (b[k] !== undefined) {
      const exists = await get('SELECT key FROM settings WHERE key = ?', [k]);
      if (exists) await run('UPDATE settings SET value = ? WHERE key = ?', [b[k], k]);
      else await run('INSERT INTO settings (key, value) VALUES (?, ?)', [k, b[k]]);
    }
  }
  res.json({ success: true });
});

module.exports = router;
