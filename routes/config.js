// Configuracoes de cobranca (chave Pix, recebedor, lembretes) + status dos
// provedores (C6 / WhatsApp).
const express = require('express');
const { authenticate } = require('./auth');
const billing = require('../billing');
const c6 = require('../c6');
const whatsapp = require('../whatsapp');

const router = express.Router();
router.use(authenticate);

const KEYS = ['pix_key', 'pix_receiver_name', 'pix_city', 'reminder_enabled', 'reminder_hour'];
const DEFAULTS = { pix_key: '', pix_receiver_name: '', pix_city: '', reminder_enabled: 'false', reminder_hour: '9' };

router.get('/', async (req, res) => {
  const settings = {};
  for (const k of KEYS) settings[k] = await billing.getSetting(k, DEFAULTS[k]);
  res.json({
    success: true,
    settings,
    c6: {
      configured: c6.configured_ok(),
      baseUrl: process.env.C6_BASE_URL || 'https://baas-api-sandbox.c6bank.info',
      hasPixKey: !!c6.pixKey(),
    },
    whatsapp: whatsapp.getStatus(),
  });
});

router.put('/', async (req, res) => {
  const b = req.body || {};
  for (const k of KEYS) {
    if (b[k] !== undefined) await billing.setSetting(k, String(b[k]));
  }
  res.json({ success: true });
});

// Dispara os lembretes agora (mesma rotina do agendador)
router.post('/run-reminders', async (req, res) => {
  try {
    const result = await billing.runReminders();
    res.json({ success: true, result });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

module.exports = router;
