// Agendador de lembretes de cobranca.
// Roda a cada 10 min; dispara UMA vez por dia (no horario configurado, fuso de
// Sao Paulo) para as cobrancas vencidas/do dia. Cada cobranca so recebe um
// lembrete por dia e para de receber quando e paga.
const billing = require('./billing');

let timer = null;
let timerReconcile = null;

function brtNow() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date()).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  return { date: parts.year + '-' + parts.month + '-' + parts.day, hour: Number(parts.hour) };
}

async function tick() {
  try {
    const enabled = String(await billing.getSetting('reminder_enabled', 'false')) !== 'false';
    if (!enabled) return;
    const hour = Number(await billing.getSetting('reminder_hour', '9'));
    const now = brtNow();
    const last = await billing.getSetting('reminder_last_date', '');
    if (now.hour < hour) return;
    if (last === now.date) return;
    await billing.setSetting('reminder_last_date', now.date);
    const res = await billing.runReminders();
    console.log('[scheduler] lembretes ' + now.date + ':', JSON.stringify(res));
  } catch (e) {
    console.error('[scheduler] erro:', e.message);
  }
}

async function reconcileTick() {
  try {
    const r = await billing.reconcilePending();
    if (r && r.paid) console.log('[scheduler] baixa automatica (reconciliacao):', JSON.stringify(r));
  } catch (e) {
    console.error('[scheduler] reconciliacao erro:', e.message);
  }
}

function start() {
  if (String(process.env.REMINDERS_ENABLED || 'true') === 'false') return;
  if (timer) return;
  timer = setInterval(tick, 10 * 60 * 1000);
  if (timer.unref) timer.unref();
  // Reconciliacao a cada 2 min: consulta o banco e da baixa nas cobrancas pagas
  // mesmo sem webhook.
  timerReconcile = setInterval(reconcileTick, 2 * 60 * 1000);
  if (timerReconcile.unref) timerReconcile.unref();
  setTimeout(tick, 90 * 1000);
  setTimeout(reconcileTick, 30 * 1000);
  console.log('[scheduler] agendador de lembretes ativo');
}

module.exports = { start, tick, reconcileTick };
