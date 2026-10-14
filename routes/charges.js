const express = require('express');
const { all, get, run } = require('../db');
const { authenticate } = require('./auth');
const billing = require('../billing');

const router = express.Router();
router.use(authenticate);

function withStatus(c) {
  if (c.status === 'pending' && c.due_date) {
    const today = new Date().toISOString().slice(0, 10);
    if (String(c.due_date).slice(0, 10) < today) return Object.assign({}, c, { status: 'overdue' });
  }
  return c;
}

router.get('/', async (req, res) => {
  const { status, client_id } = req.query;
  let sql = `SELECT ch.*, c.name AS client_name, c.phone AS client_phone FROM charges ch LEFT JOIN clients c ON c.id = ch.client_id`;
  const where = [];
  const params = [];
  if (client_id) { where.push('ch.client_id = ?'); params.push(client_id); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY ch.due_date DESC, ch.id DESC';
  let rows = (await all(sql, params)).map(withStatus);
  if (status) {
    rows = rows.filter((r) => {
      if (status === 'pending') return r.status === 'pending';
      if (status === 'overdue') return r.status === 'overdue';
      return r.status === status;
    });
  }
  res.json({ success: true, charges: rows });
});

router.post('/', async (req, res) => {
  const { client_id, description, amount, amount_cents, due_date, method, type, recurrence, gateway } = req.body || {};
  if (!description) return res.status(400).json({ success: false, message: 'Informe a descricao.' });
  const cents = amount_cents !== undefined ? Number(amount_cents) : Math.round(Number(amount || 0) * 100);
  const r = await run(
    `INSERT INTO charges (client_id, description, amount_cents, due_date, method, type, recurrence, gateway)
     VALUES (?,?,?,?,?,?,?,?)`,
    [client_id || null, description, cents, due_date || null, method || 'pix', type || 'avulsa', recurrence || null, gateway || null]
  );
  res.json({ success: true, charge: await get('SELECT * FROM charges WHERE id = ?', [r.id]) });
});

router.put('/:id', async (req, res) => {
  const ch = await get('SELECT * FROM charges WHERE id = ?', [req.params.id]);
  if (!ch) return res.status(404).json({ success: false, message: 'Cobranca nao encontrada.' });
  const b = req.body || {};
  const cents = b.amount_cents !== undefined ? Number(b.amount_cents)
    : (b.amount !== undefined ? Math.round(Number(b.amount) * 100) : ch.amount_cents);
  await run('UPDATE charges SET client_id=?, description=?, amount_cents=?, due_date=?, method=?, type=?, recurrence=?, status=? WHERE id=?', [
    b.client_id === undefined ? ch.client_id : (b.client_id || null),
    b.description || ch.description,
    cents,
    b.due_date === undefined ? ch.due_date : b.due_date,
    b.method || ch.method,
    b.type || ch.type,
    b.recurrence === undefined ? ch.recurrence : b.recurrence,
    b.status || ch.status,
    ch.id,
  ]);
  res.json({ success: true, charge: await get('SELECT * FROM charges WHERE id = ?', [ch.id]) });
});

router.delete('/:id', async (req, res) => {
  await run('DELETE FROM charges WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// Dar baixa (pagamento)
router.post('/:id/pay', async (req, res) => {
  const ch = await get('SELECT * FROM charges WHERE id = ?', [req.params.id]);
  if (!ch) return res.status(404).json({ success: false, message: 'Cobranca nao encontrada.' });
  await run("UPDATE charges SET status = 'paid', paid_at = datetime('now') WHERE id = ?", [ch.id]);
  // Baixa automatica -> avisa pagamento se houver telefone
  res.json({ success: true, charge: await get('SELECT * FROM charges WHERE id = ?', [ch.id]) });
});

router.post('/:id/cancel', async (req, res) => {
  await run("UPDATE charges SET status = 'canceled' WHERE id = ?", [req.params.id]);
  res.json({ success: true });
});

// Gera/atualiza o Pix (copia e cola) da cobranca
router.post('/:id/pix', async (req, res) => {
  const ch = await billing.loadCharge(req.params.id);
  if (!ch) return res.status(404).json({ success: false, message: 'Cobranca nao encontrada.' });
  try {
    const force = !!(req.body && req.body.force);
    const r = await billing.ensurePix(ch, { force });
    if (!r.payload) return res.status(400).json({ success: false, message: r.error || 'Nao foi possivel gerar o Pix.' });
    res.json({ success: true, pix: r.payload, txid: r.txid, source: r.source });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// Envia a cobranca agora (garante o Pix e registra no log)
router.post('/:id/notify', async (req, res) => {
  const ch = await billing.loadCharge(req.params.id);
  if (!ch) return res.status(404).json({ success: false, message: 'Cobranca nao encontrada.' });
  if (!ch.client_phone) return res.status(400).json({ success: false, message: 'Cliente sem telefone cadastrado.' });
  try {
    const out = await billing.sendCharge(ch);
    res.json({ success: out.status === 'sent', status: out.status, error: out.error, pix: out.pix });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

// Simula um pagamento (teste): da baixa e avisa o cliente no WhatsApp
router.post('/:id/simulate-pay', async (req, res) => {
  const out = await billing.markPaidAndNotify(Number(req.params.id), 'simulado', 'teste');
  res.json({ success: out.ok, detail: out });
});

// Reenvia a mensagem de "pagamento recebido" (para cobranca ja paga)
router.post('/:id/notify-paid', async (req, res) => {
  const ch = await billing.loadCharge(req.params.id);
  if (!ch) return res.status(404).json({ success: false, message: 'Cobranca nao encontrada.' });
  try {
    const out = await billing.sendPaid(ch);
    res.json({ success: out.status === 'sent', status: out.status, error: out.error });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

module.exports = router;
