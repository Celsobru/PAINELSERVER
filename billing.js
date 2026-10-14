// Motor de cobranca: monta o Pix da cobranca, envia no WhatsApp (com log em
// notifications) e da baixa automatica. Usado pelas rotas e pelo agendador.
const { all, get, run } = require('./db');
const whatsapp = require('./whatsapp');
const pix = require('./pix');
const c6 = require('./c6');

/* ---------- formatos ---------- */
function formatBRL(cents) {
  return 'R$ ' + (Number(cents || 0) / 100).toFixed(2).replace('.', ',');
}
function formatDate(d) {
  if (!d) return '-';
  const p = String(d).slice(0, 10).split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : d;
}
function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''));
}

/* ---------- settings ---------- */
async function getSetting(key, def) {
  const r = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return r && r.value !== null && r.value !== undefined ? r.value : def;
}
async function setSetting(key, value) {
  const r = await get('SELECT value FROM settings WHERE key = ?', [key]);
  if (r) await run('UPDATE settings SET value = ? WHERE key = ?', [value, key]);
  else await run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

/* ---------- Pix ---------- */
// txid para BR Code estatico (local): ate 25 caracteres alfanumericos
function txidLocal(charge) {
  return ('VISION' + String(charge.id).padStart(10, '0')).slice(0, 25);
}
// txid para a API do banco (Pix cob/cobv): 26 a 35 caracteres alfanumericos
function txidBank(charge) {
  return ('VISION' + String(charge.id).padStart(22, '0')).slice(0, 32);
}
function isValidBankTxid(t) { return /^[A-Za-z0-9]{26,35}$/.test(String(t || '')); }

async function loadCharge(id) {
  return get(
    'SELECT ch.*, c.name AS client_name, c.phone AS client_phone FROM charges ch LEFT JOIN clients c ON c.id = ch.client_id WHERE ch.id = ?',
    [id]
  );
}

// Garante que a cobranca tenha um Pix. Tenta o C6 (se configurado) e, se falhar,
// cai no BR Code gerado localmente com a chave configurada.
async function ensurePix(charge, opts) {
  const o = opts || {};
  if (!o.force && charge.pix_copia_cola) {
    return { payload: charge.pix_copia_cola, txid: charge.txid, source: charge.gateway === 'c6' ? 'c6' : 'local', cached: true };
  }
  const useBank = c6.configured_ok();
  const txid = useBank
    ? (isValidBankTxid(charge.txid) ? charge.txid : txidBank(charge))
    : ((charge.txid && String(charge.txid).length <= 25) ? charge.txid : txidLocal(charge));

  // 1) Banco C6
  if (useBank) {
    try {
      const resp = await c6.createImmediateCharge({ amountCents: charge.amount_cents, txid, description: charge.description });
      const payload = resp && resp.pixCopiaECola ? resp.pixCopiaECola : null;
      const finalTxid = (resp && resp.txid) ? resp.txid : txid;
      const location = resp && resp.location ? (resp.location.location || null) : null;
      if (payload) {
        await run("UPDATE charges SET txid = ?, pix_copia_cola = ?, pix_location = ?, gateway = 'c6' WHERE id = ?", [finalTxid, payload, location, charge.id]);
        return { payload, txid: finalTxid, source: 'c6' };
      }
      console.error('[billing] C6 nao retornou pixCopiaECola, usando Pix local');
    } catch (e) {
      console.error('[billing] C6 falhou, usando Pix local:', e.message);
    }
  }

  // 2) Pix local (BR Code)
  const key = await getSetting('pix_key', '');
  if (!key) return { payload: null, txid, source: 'none', error: 'Chave Pix nao configurada' };
  const name = await getSetting('pix_receiver_name', '');
  const city = await getSetting('pix_city', '');
  const payload = pix.buildPix({
    key,
    name: name || 'RECEBEDOR',
    city: city || 'CIDADE',
    amountCents: charge.amount_cents,
    txid,
    description: charge.description,
  });
  await run('UPDATE charges SET txid = ?, pix_copia_cola = ? WHERE id = ?', [txid, payload, charge.id]);
  return { payload, txid, source: 'local' };
}

/* ---------- mensagens ---------- */
async function buildChargeMessage(charge) {
  const pixRes = await ensurePix(charge);
  const tplRow = await get('SELECT value FROM settings WHERE key = ?', ['tpl_charge']);
  const vars = {
    cliente: charge.client_name || 'cliente',
    descricao: charge.description,
    valor: formatBRL(charge.amount_cents),
    vencimento: formatDate(charge.due_date),
    pix: pixRes.payload || '',
    txid: pixRes.txid || '',
  };
  let message = fillTemplate(tplRow && tplRow.value, vars);
  if (pixRes.payload && message.indexOf(pixRes.payload) === -1) {
    message += '\n\n*Pix copia e cola:*\n' + pixRes.payload;
  }
  return { message, pix: pixRes.payload, txid: pixRes.txid, source: pixRes.source };
}

async function buildPaidMessage(charge) {
  const tplRow = await get('SELECT value FROM settings WHERE key = ?', ['tpl_paid']);
  return fillTemplate(tplRow && tplRow.value, {
    cliente: charge.client_name || 'cliente',
    valor: formatBRL(charge.amount_cents),
    descricao: charge.description,
  });
}

/* ---------- envio ---------- */
async function sendAndLog(payload) {
  let status = 'queued';
  let error = null;
  try {
    await whatsapp.sendMessage(payload.phone, payload.message);
    status = 'sent';
  } catch (e) {
    status = 'failed';
    error = e.message || String(e);
  }
  const r = await run(
    "INSERT INTO notifications (client_id, charge_id, channel, destination, message, status, error, sent_at) VALUES (?,?, 'whatsapp', ?,?,?,?, CASE WHEN ? = 'sent' THEN datetime('now') ELSE NULL END)",
    [payload.client_id || null, payload.charge_id || null, payload.phone, payload.message, status, error, status]
  );
  return { id: r.id, status, error };
}

async function touchCharge(id) {
  await run("UPDATE charges SET last_notified_at = datetime('now'), notify_count = COALESCE(notify_count, 0) + 1 WHERE id = ?", [id]);
}

// Envia a cobranca para o telefone do cliente (garante o Pix).
async function sendCharge(charge) {
  const phone = charge.client_phone;
  if (!phone) throw new Error('Cliente sem telefone cadastrado.');
  const built = await buildChargeMessage(charge);
  const out = await sendAndLog({ client_id: charge.client_id, charge_id: charge.id, phone, message: built.message });
  if (out.status === 'sent') await touchCharge(charge.id);
  return Object.assign(out, { pix: built.pix, source: built.source });
}

async function sendPaid(charge) {
  const phone = charge.client_phone;
  if (!phone) return { status: 'skipped', error: 'sem telefone' };
  const message = await buildPaidMessage(charge);
  return sendAndLog({ client_id: charge.client_id, charge_id: charge.id, phone, message });
}

/* ---------- baixa ---------- */
async function markPaidAndNotify(chargeId, gateway, gatewayId) {
  const ch = await loadCharge(chargeId);
  if (!ch) return { ok: false, reason: 'charge_not_found' };
  if (ch.status === 'paid') return { ok: true, already: true };
  await run(
    "UPDATE charges SET status = 'paid', paid_at = datetime('now'), gateway = ?, gateway_id = ?, paid_via = ? WHERE id = ?",
    [gateway || ch.gateway || 'manual', gatewayId || ch.gateway_id || null, gateway || 'manual', chargeId]
  );
  let notify = null;
  try { notify = await sendPaid(ch); } catch (e) { notify = { status: 'failed', error: e.message }; }
  return { ok: true, charge: ch, notify };
}

/* ---------- lembretes ---------- */
function todayStr() { return new Date().toISOString().slice(0, 10); }

// Envia a cobranca para todas as cobrancas vencidas/a vencer, uma vez por dia,
// ate o pagamento. Retorna um resumo.
async function runReminders() {
  const enabled = String(await getSetting('reminder_enabled', 'false')) !== 'false';
  if (!enabled) return { skipped: 'lembretes desativados' };
  const today = todayStr();
  const rows = await all(
    `SELECT ch.*, c.name AS client_name, c.phone AS client_phone
       FROM charges ch JOIN clients c ON c.id = ch.client_id
      WHERE ch.status IN ('pending','overdue')
        AND ch.due_date IS NOT NULL AND date(ch.due_date) <= date(?)
        AND c.phone IS NOT NULL AND TRIM(c.phone) <> ''
        AND (ch.last_notified_at IS NULL OR date(ch.last_notified_at) < date(?))`,
    [today, today]
  );
  let sent = 0, failed = 0;
  for (const ch of rows) {
    try {
      const out = await sendCharge(ch);
      if (out.status === 'sent') sent++; else failed++;
    } catch (e) {
      failed++;
    }
  }
  await setSetting('reminder_last_run', new Date().toISOString());
  return { candidates: rows.length, sent, failed };
}

module.exports = {
  formatBRL,
  formatDate,
  fillTemplate,
  getSetting,
  setSetting,
  ensurePix,
  buildChargeMessage,
  buildPaidMessage,
  sendAndLog,
  sendCharge,
  sendPaid,
  touchCharge,
  markPaidAndNotify,
  runReminders,
  loadCharge,
};
