const express = require('express');
const { authenticate } = require('./auth');
const whatsapp = require('../whatsapp');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  res.json(Object.assign({ success: true }, whatsapp.getStatus()));
});

router.get('/qr', async (req, res) => {
  res.json({ success: true, status: whatsapp.status, qrCode: whatsapp.qrCodeBase64 });
});

router.post('/start', async (req, res) => {
  whatsapp.start().catch(() => {});
  res.json({ success: true, message: 'Iniciando WhatsApp...' });
});

router.post('/restart', async (req, res) => {
  whatsapp.restart(false).catch(() => {});
  res.json({ success: true, message: 'Reiniciando WhatsApp...' });
});

router.post('/logout', async (req, res) => {
  await whatsapp.stop(true);
  setTimeout(() => whatsapp.start().catch(() => {}), 1000);
  res.json({ success: true, message: 'Sessao apagada. Escaneie o QR de novo.' });
});

router.post('/test', async (req, res) => {
  const phone = (req.body && req.body.phone) || '';
  if (!phone) return res.status(400).json({ success: false, message: 'Informe o telefone.' });
  try {
    await whatsapp.sendMessage(phone, 'Teste do Painel Server - se voce recebeu esta mensagem, o WhatsApp esta funcionando! ✅');
    res.json({ success: true, message: 'Mensagem enviada.' });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || 'Falha ao enviar.' });
  }
});

module.exports = router;
