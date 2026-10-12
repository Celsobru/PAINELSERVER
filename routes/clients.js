const express = require('express');
const { all, get, run } = require('../db');
const { authenticate } = require('./auth');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  let rows;
  if (q) {
    rows = await all(
      'SELECT * FROM clients WHERE name LIKE ? OR company LIKE ? OR email LIKE ? OR phone LIKE ? ORDER BY name',
      ['%' + q + '%', '%' + q + '%', '%' + q + '%', '%' + q + '%']
    );
  } else {
    rows = await all('SELECT * FROM clients ORDER BY name');
  }
  res.json({ success: true, clients: rows });
});

router.get('/:id', async (req, res) => {
  const c = await get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ success: false, message: 'Cliente nao encontrado.' });
  const sites = await all('SELECT * FROM sites WHERE client_id = ?', [c.id]);
  const charges = await all('SELECT * FROM charges WHERE client_id = ? ORDER BY due_date DESC', [c.id]);
  res.json({ success: true, client: c, sites, charges });
});

router.post('/', async (req, res) => {
  try {
    const { name, company, email, phone, document, notes } = req.body || {};
    if (!name) return res.status(400).json({ success: false, message: 'Informe o nome do cliente.' });
    const r = await run(
      'INSERT INTO clients (name, company, email, phone, document, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [name, company || '', email || '', phone || '', document || '', notes || '']
    );
    const client = await get('SELECT * FROM clients WHERE id = ?', [r.lastID]);
    res.json({ success: true, client });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erro ao salvar cliente.' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, company, email, phone, document, notes, active } = req.body || {};
    const c = await get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!c) return res.status(404).json({ success: false, message: 'Cliente nao encontrado.' });
    await run(
      'UPDATE clients SET name=?, company=?, email=?, phone=?, document=?, notes=?, active=? WHERE id=?',
      [
        name != null ? name : c.name,
        company !== undefined ? company : c.company,
        email !== undefined ? email : c.email,
        phone !== undefined ? phone : c.phone,
        document !== undefined ? document : c.document,
        notes !== undefined ? notes : c.notes,
        active === undefined ? c.active : (active ? 1 : 0),
        c.id,
      ]
    );
    const updated = await get('SELECT * FROM clients WHERE id = ?', [c.id]);
    res.json({ success: true, client: updated });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

router.delete('/:id', async (req, res) => {
  await run('DELETE FROM clients WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
