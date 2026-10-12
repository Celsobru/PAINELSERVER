const express = require('express');
const { execFile } = require('child_process');
const { all, get, run } = require('../db');
const { authenticate } = require('./auth');

const router = express.Router();
router.use(authenticate);

function pm2List() {
  return new Promise((resolve) => {
    execFile('pm2', ['jlist'], { maxBuffer: 1024 * 1024 * 8 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const list = JSON.parse(stdout);
        resolve(list.map((p) => ({
          name: p.name,
          status: p.pm2_env ? p.pm2_env.status : 'unknown',
          restarts: p.pm2_env ? p.pm2_env.restart_time : 0,
          uptime: p.pm2_env ? p.pm2_env.pm_uptime : null,
          cpu: p.monit ? p.monit.cpu : 0,
          memory: p.monit ? p.monit.memory : 0,
          pid: p.pid,
        })));
      } catch (e) {
        resolve(null);
      }
    });
  });
}

// Status de todos os apps do PM2 (inclui os que nao estao cadastrados)
router.get('/status', async (req, res) => {
  const list = await pm2List();
  if (!list) return res.json({ success: true, available: false, pm2: [] });
  const sites = await all('SELECT * FROM sites ORDER BY name');
  const byName = {};
  sites.forEach((s) => { if (s.pm2_name) byName[s.pm2_name] = s; });
  const merged = list.map((p) => Object.assign({}, p, { site: byName[p.name] || null }));
  res.json({ success: true, available: true, pm2: merged });
});

router.get('/', async (req, res) => {
  const rows = await all(`SELECT s.*, c.name AS client_name FROM sites s LEFT JOIN clients c ON c.id = s.client_id ORDER BY s.name`);
  res.json({ success: true, sites: rows });
});

router.post('/', async (req, res) => {
  const { name, client_id, domain, port, pm2_name, repo, notes } = req.body || {};
  if (!name) return res.status(400).json({ success: false, message: 'Informe o nome do site.' });
  const r = await run(
    'INSERT INTO sites (name, client_id, domain, port, pm2_name, repo, notes) VALUES (?,?,?,?,?,?,?)',
    [name, client_id || null, domain || null, port || null, pm2_name || null, repo || null, notes || null]
  );
  res.json({ success: true, site: await get('SELECT * FROM sites WHERE id = ?', [r.id]) });
});

router.put('/:id', async (req, res) => {
  const s = await get('SELECT * FROM sites WHERE id = ?', [req.params.id]);
  if (!s) return res.status(404).json({ success: false, message: 'Site nao encontrado.' });
  const b = req.body || {};
  await run('UPDATE sites SET name=?, client_id=?, domain=?, port=?, pm2_name=?, repo=?, active=?, notes=? WHERE id=?', [
    b.name || s.name,
    b.client_id === undefined ? s.client_id : (b.client_id || null),
    b.domain === undefined ? s.domain : b.domain,
    b.port === undefined ? s.port : b.port,
    b.pm2_name === undefined ? s.pm2_name : b.pm2_name,
    b.repo === undefined ? s.repo : b.repo,
    b.active === undefined ? s.active : (b.active ? 1 : 0),
    b.notes === undefined ? s.notes : b.notes,
    s.id,
  ]);
  res.json({ success: true, site: await get('SELECT * FROM sites WHERE id = ?', [s.id]) });
});

router.delete('/:id', async (req, res) => {
  await run('DELETE FROM sites WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// Acao no PM2: restart | stop | start | reload
router.post('/:id/action', async (req, res) => {
  const s = await get('SELECT * FROM sites WHERE id = ?', [req.params.id]);
  if (!s || !s.pm2_name) return res.status(400).json({ success: false, message: 'Site sem processo PM2 cadastrado.' });
  const action = (req.body && req.body.action) || 'restart';
  if (!['restart', 'stop', 'start', 'reload'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Acao invalida.' });
  }
  execFile('pm2', [action, String(s.pm2_name)], { maxBuffer: 1024 * 1024 * 4 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ success: false, message: (stderr || err.message || '').toString().slice(0, 500) });
    res.json({ success: true, output: (stdout || '').toString().slice(0, 2000) });
  });
});

// Acao direta no PM2 pelo nome do processo (funciona tambem para apps nao cadastrados)
router.post('/pm2/:name/:action', async (req, res) => {
  const { name, action } = req.params;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return res.status(400).json({ success: false, message: 'Nome de processo invalido.' });
  }
  if (!['restart', 'stop', 'start', 'reload'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Acao invalida.' });
  }
  execFile('pm2', [action, name], { maxBuffer: 1024 * 1024 * 4 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ success: false, message: (stderr || err.message || '').toString().slice(0, 500) });
    res.json({ success: true, output: (stdout || '').toString().slice(0, 2000) });
  });
});

module.exports = router;
