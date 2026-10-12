// Webhooks dos gateways de pagamento -> baixa automatica
// Pluggable: adicione novos provedores conforme necessario.
const express = require('express');
const { all, get, run } = require('../db');

const router = express.Router();

async function markPaid(chargeId, gateway, gatewayId) {
  const ch = await get('SELECT * FROM charges WHERE id = ?', [chargeId]);
  if (!ch) return { ok: false, reason: 'charge_not_found' };
  if (ch.status === 'paid') return { ok: true, already: true };
  await run("UPDATE charges SET status = 'paid', paid_at = datetime('now'), gateway = ?, gateway_id = ? WHERE id = ?", [gateway, gatewayId, chargeId]);
  return { ok: true, charge: ch };
}

// Mercado Pago: notificacao com ?type=payment&data.id=... -> buscamos o pagamento via API
router.post('/mercadopago', async (req, res) => {
  try {
    const body = req.body || {};
    const paymentId = body.data && body.data.id ? body.data.id : body.id;
    const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (!paymentId || !token) return res.status(200).json({ received: true, note: 'sem paymentId ou token' });

    const resp = await fetch('https://api.mercadopago.com/v1/payments/' + paymentId, {
      headers: { Authorization: 'Bearer ' + token },
    });
    const pay = await resp.json();
    if (!pay || pay.status !== 'approved') return res.status(200).json({ received: true, status: pay && pay.status });

    const ref = pay.external_reference || (pay.metadata && pay.metadata.charge_id);
    if (ref) {
      await markPaid(Number(ref), 'mercadopago', String(paymentId));
    }
    res.status(200).json({ received: true });
  } catch (e) {
    console.error('webhook mercadopago:', e.message);
    res.status(200).json({ received: true });
  }
});

// Provedor generico: { charge_id, gateway, gateway_id }
// Exige segredo compartilhado (header x-webhook-secret ou ?secret=) para evitar
// que qualquer pessoa marque cobrancas como pagas.
router.post('/generic', async (req, res) => {
  const expected = process.env.WEBHOOK_SECRET;
  const provided = req.headers['x-webhook-secret'] || req.query.secret;
  if (!expected || provided !== expected) {
    return res.status(401).json({ success: false, message: 'Nao autorizado.' });
  }
  const { charge_id, gateway, gateway_id } = req.body || {};
  if (!charge_id) return res.status(400).json({ success: false, message: 'Informe charge_id.' });
  const out = await markPaid(Number(charge_id), gateway || 'generic', gateway_id || null);
  res.json({ success: out.ok, detail: out });
});

module.exports = router;
