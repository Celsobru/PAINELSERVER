const express = require('express');
const { all, get } = require('../db');
const { authenticate } = require('./auth');
const billing = require('../billing');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  const rows = await all(`SELECT n.*, c.name AS client_name FROM notifications n LEFT JOIN clients c ON c.id = n.client_id ORDER BY n.id DESC LIMIT 200`);
  res.json({ success: true, notifications: rows });
});

// Enviar cobranca (garante o Pix; usa template tpl_charge; permite override via body)
router.post('/charge/:id', async (req, res) => {
  const ch = await billing.loadCharge(req.params.id);
  if (!ch) return res.status(404).json({ success: false, message: 'Cobranca nao encontrada.' });
  const phone = (req.body && req.body.phone) || ch.client_phone;
  if (!phone) return res.status(400).json({ success: false, message: 'Cliente sem telefone cadastrado.' });
  const built = await billing.buildChargeMessage(ch);
  const message = (req.body && req.body.message) || built.message;
  const out = await billing.sendAndLog({ client_id: ch.client_id, charge_id: ch.id, phone, message });
  if (out.status === 'sent') await billing.touchCharge(ch.id);
  res.json({ success: out.status === 'sent', status: out.status, error: out.error, pix: built.pix });
});

// Enviar aviso de pagamento recebido
router.post('/paid/:id', async (req, res) => {
  const ch = await billing.loadCharge(req.params.id);
  if (!ch) return res.status(404).json({ success: false, message: 'Cobranca nao encontrada.' });
  const phone = (req.body && req.body.phone) || ch.client_phone;
  if (!phone) return res.status(400).json({ success: false, message: 'Cliente sem telefone cadastrado.' });
  const message = (req.body && req.body.message) || (await billing.buildPaidMessage(ch));
  const out = await billing.sendAndLog({ client_id: ch.client_id, charge_id: ch.id, phone, message });
  res.json({ success: out.status === 'sent', status: out.status, error: out.error });
});

// Envio avulso
router.post('/send', async (req, res) => {
  const { phone, message, client_id } = req.body || {};
  if (!phone || !message) return res.status(400).json({ success: false, message: 'Informe telefone e mensagem.' });
  const out = await billing.sendAndLog({ client_id: client_id || null, charge_id: null, phone, message });
  res.json({ success: out.status === 'sent', status: out.status, error: out.error });
});

// Envia agora para todas as cobrancas vencidas/pendentes (garante o Pix de cada)
router.post('/remind-overdue', async (req, res) => {
  const rows = await all(
    `SELECT ch.*, c.name AS client_name, c.phone AS client_phone
       FROM charges ch JOIN clients c ON c.id = ch.client_id
      WHERE ch.status IN ('pending','overdue')
        AND c.phone IS NOT NULL AND TRIM(c.phone) <> ''`
  );
  let sent = 0, failed = 0;
  for (const ch of rows) {
    try {
      const out = await billing.sendCharge(ch);
      if (out.status === 'sent') sent++; else failed++;
    } catch (e) {
      failed++;
    }
  }
  res.json({ success: true, total: rows.length, sent, failed });
});

// Modelos de mensagem
router.get('/templates', async (req, res) => {
  const rows = await all(`SELECT key, value FROM settings WHERE key IN ('tpl_charge','tpl_paid')`);
  const templates = {};
  rows.forEach((r) => { templates[r.key] = r.value; });
  res.json({ success: true, templates });
});

router.put('/templates', async (req, res) => {
  const b = req.body || {};
  for (const k of ['tpl_charge', 'tpl_paid']) {
    if (b[k] !== undefined) await billing.setSetting(k, b[k]);
  }
  res.json({ success: true });
});

module.exports = router;
