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
          cwd: p.pm2_env ? p.pm2_env.pm_cwd : null,
        })));
      } catch (e) {
        resolve(null);
      }
    });
  });
}

// ---- Armazenamento (tamanho da pasta) via `du -sm`, com cache em memoria ----
const diskCache = new Map(); // dir -> { ts, mb }
const DISK_TTL = 10 * 60 * 1000; // 10 min

function dirSizeMB(dir) {
  return new Promise((resolve) => {
    if (!dir) return resolve(null);
    const cached = diskCache.get(dir);
    if (cached && Date.now() - cached.ts < DISK_TTL) return resolve(cached.mb);
    execFile('du', ['-sm', dir], { maxBuffer: 1024 * 1024, timeout: 60000 }, (err, stdout) => {
      if (err) return resolve(cached ? cached.mb : null);
      const mb = parseInt(String(stdout).trim().split(/\s+/)[0], 10);
      if (isNaN(mb)) return resolve(cached ? cached.mb : null);
      diskCache.set(dir, { ts: Date.now(), mb });
      resolve(mb);
    });
  });
}

// ---- Docker ----
function dockerPs() {
  return new Promise((resolve) => {
    execFile('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.State}}'], { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const rows = String(stdout).trim().split('\n').filter(Boolean).map((line) => {
        const parts = line.split('\t');
        return { name: parts[0], image: parts[1] || '', status: parts[2] || '', state: parts[3] || '' };
      });
      resolve(rows);
    });
  });
}

function dockerStats() {
  return new Promise((resolve) => {
    execFile('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'], { maxBuffer: 1024 * 1024, timeout: 25000 }, (err, stdout) => {
      if (err) return resolve({});
      const map = {};
      String(stdout).trim().split('\n').filter(Boolean).forEach((line) => {
        const parts = line.split('\t');
        if (parts[0]) map[parts[0]] = { cpu: parts[1] || '', mem: parts[2] || '' };
      });
      resolve(map);
    });
  });
}

function dockerSizes() {
  return new Promise((resolve) => {
    execFile('docker', ['ps', '--size', '--format', '{{.Names}}\t{{.Size}}'], { maxBuffer: 1024 * 1024, timeout: 25000 }, (err, stdout) => {
      if (err) return resolve({});
      const map = {};
      String(stdout).trim().split('\n').filter(Boolean).forEach((line) => {
        const idx = line.indexOf('\t');
        if (idx > 0) map[line.slice(0, idx)] = line.slice(idx + 1);
      });
      resolve(map);
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
  const merged = await Promise.all(list.map(async (p) => Object.assign({}, p, { disk: await dirSizeMB(p.cwd), site: byName[p.name] || null })));
  res.json({ success: true, available: true, pm2: merged });
});

// Containers Docker (Bruhouse e outros)
router.get('/docker', async (req, res) => {
  const list = await dockerPs();
  if (!list) return res.json({ success: true, available: false, containers: [] });
  const [stats, sizes] = await Promise.all([dockerStats(), dockerSizes()]);
  const containers = list.map((c) => Object.assign({}, c, stats[c.name] || {}, { size: sizes[c.name] || null }));
  res.json({ success: true, available: true, containers });
});

// Acao em container Docker: restart | stop | start
router.post('/docker/:name/:action', (req, res) => {
  const { name, action } = req.params;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return res.status(400).json({ success: false, message: 'Nome de container invalido.' });
  if (!['restart', 'stop', 'start'].includes(action)) return res.status(400).json({ success: false, message: 'Acao invalida.' });
  execFile('docker', [action, name], { maxBuffer: 1024 * 1024 * 4, timeout: 60000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ success: false, message: (stderr || err.message || '').toString().slice(0, 500) });
    res.json({ success: true, output: (stdout || '').toString().slice(0, 2000) });
  });
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
