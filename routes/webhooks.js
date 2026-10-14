// Webhooks dos gateways de pagamento -> baixa automatica
// Pluggable: adicione novos provedores conforme necessario.
const express = require('express');
const { all, get, run } = require('../db');
const billing = require('../billing');
const c6 = require('../c6');

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

// ---------------------------------------------------------------------------
// C6 Bank (Pix). O C6 NAO assina o payload, entao a prova de origem e o token
// na URL (?token=...) + reconsulta ao banco antes de dar baixa.
// URL a cadastrar: https://SEU-DOMINIO/painelserver/api/webhooks/c6?token=SEGREDO
// ---------------------------------------------------------------------------
function collectItems(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.txid || node.endToEndId || node.e2eid) out.push(node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') collectItems(v, out);
  }
}

// Reconsulta o banco para confirmar o pagamento. O C6 nao assina o webhook, e a
// propagacao no endpoint de consulta pode demorar alguns segundos depois do
// pagamento, entao tentamos algumas vezes antes de desistir (a reconciliacao
// cobre o caso de nao confirmar aqui).
async function confirmWithRetry(txid, attempts) {
  const n = attempts || 5;
  let last = '';
  for (let i = 0; i < n; i++) {
    if (!c6.configured_ok()) return { confirmed: true, last: 'c6_nao_configurado' };
    try {
      const bank = await c6.getChargeByTxid(txid);
      const st = bank && bank.status ? String(bank.status).toUpperCase() : '';
      if (st === 'CONCLUIDA' || st === 'CONCLUIDO') return { confirmed: true, bank, last: st };
      last = st || 'sem_status';
    } catch (e) {
      last = 'erro: ' + e.message;
    }
    if (i < 4) await new Promise((r) => setTimeout(r, 3000));
  }
  return { confirmed: false, last };
}

router.get('/c6', (req, res) => res.status(200).json({ ok: true }));

router.post('/c6', async (req, res) => {
  try {
    // Corpo cru (montado com express.raw no server.js): registra o que chegou
    // e tenta parsear JSON manualmente, independente do content-type.
    let body = req.body;
    if (Buffer.isBuffer(body)) {
      const raw = body.toString('utf8');
      console.log('[webhook c6] recebido ip=%s ct=%s len=%d body=%s', req.ip, req.headers['content-type'] || '-', raw.length, raw.slice(0, 600));
      try { body = raw.trim() ? JSON.parse(raw) : {}; } catch (e) { console.error('[webhook c6] JSON invalido:', raw.slice(0, 400)); body = {}; }
    } else {
      console.log('[webhook c6] recebido ip=%s ct=%s body=%s', req.ip, req.headers['content-type'] || '-', JSON.stringify(body || {}).slice(0, 600));
    }

    const expected = process.env.C6_WEBHOOK_TOKEN;
    const provided = req.query.token || req.headers['x-webhook-token'];
    if (!expected || provided !== expected) {
      return res.status(401).json({ success: false, message: 'Nao autorizado.' });
    }

    const items = [];
    collectItems(body, items);
    if (body.information) {
      try { collectItems(JSON.parse(body.information), items); } catch (e) { /* ignore */ }
    }

    const results = [];
    for (const it of items) {
      const txid = it.txid;
      if (!txid) continue;
      const ch = await get('SELECT * FROM charges WHERE txid = ?', [txid]);
      if (!ch) { results.push({ txid, status: 'charge_not_found' }); continue; }

      // Reconsulta o banco para confirmar (o C6 nao assina o webhook), com retentativas.
      let confirmed = true;
      if (c6.configured_ok()) {
        const conf = await confirmWithRetry(txid, 5);
        confirmed = conf.confirmed;
        if (!confirmed) results.push({ txid, status: 'nao_confirmado', bank: conf.last });
      }
      if (!confirmed) continue;

      const out = await billing.markPaidAndNotify(ch.id, 'c6', it.endToEndId || it.e2eid || txid);
      results.push({ txid, charge_id: ch.id, ok: out.ok, already: out.already });
    }

    console.log('[webhook c6] resultados:', JSON.stringify(results));
    res.status(200).json({ success: true, processed: results.length, results });
  } catch (e) {
    console.error('webhook c6:', e.message);
    res.status(200).json({ success: true });
  }
});

module.exports = router;
