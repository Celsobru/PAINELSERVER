const express = require('express');
const { all, get } = require('../db');
const { authenticate } = require('./auth');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  const clients = await get('SELECT COUNT(*) AS n FROM clients WHERE active = 1');
  const sites = await get('SELECT COUNT(*) AS n FROM sites WHERE active = 1');

  const charges = await all('SELECT status, amount_cents, due_date FROM charges');
  const today = new Date().toISOString().slice(0, 10);
  let pending = 0, overdue = 0, paid = 0, canceled = 0;
  let pendingCents = 0, overdueCents = 0, paidCents = 0;
  for (const c of charges) {
    const isOverdue = c.status === 'pending' && c.due_date && String(c.due_date).slice(0, 10) < today;
    if (c.status === 'paid') { paid++; paidCents += c.amount_cents; }
    else if (c.status === 'canceled') { canceled++; }
    else if (isOverdue) { overdue++; overdueCents += c.amount_cents; }
    else { pending++; pendingCents += c.amount_cents; }
  }

  const recent = await all(`SELECT ch.id, ch.description, ch.amount_cents, ch.due_date, ch.status, c.name AS client_name
    FROM charges ch LEFT JOIN clients c ON c.id = ch.client_id ORDER BY ch.id DESC LIMIT 8`);
  const notifications = await all(`SELECT n.id, n.destination, n.status, n.created_at, c.name AS client_name
    FROM notifications n LEFT JOIN clients c ON c.id = n.client_id ORDER BY n.id DESC LIMIT 8`);

  res.json({
    success: true,
    totals: {
      clients: clients.n,
      sites: sites.n,
      charges: charges.length,
      pending, overdue, paid, canceled,
      pendingCents, overdueCents, paidCents,
    },
    recentCharges: recent,
    recentNotifications: notifications,
  });
});

module.exports = router;
