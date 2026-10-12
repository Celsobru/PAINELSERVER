const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { get, run } = require('../db');

const router = express.Router();
const crypto = require('crypto');
let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] AVISO: JWT_SECRET nao definido no .env. Usando segredo aleatorio temporario (sessoes caem ao reiniciar). Defina JWT_SECRET.');
}

// Rate limit simples para o login (por IP)
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const ip = (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').toString().split(',')[0].trim();
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec || now - rec.ts > 15 * 60 * 1000) { rec = { count: 0, ts: now }; loginAttempts.set(ip, rec); }
  if (rec.count >= 10) return res.status(429).json({ success: false, message: 'Muitas tentativas de login. Tente novamente em alguns minutos.' });
  rec.count += 1;
  req._loginRec = rec;
  next();
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Token nao informado.' });
  try {
    req.admin = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Sessao expirada. Entre novamente.' });
  }
}

router.post('/login', loginRateLimit, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ success: false, message: 'Informe email e senha.' });
    const admin = await get('SELECT * FROM admins WHERE email = ?', [String(email).toLowerCase().trim()]);
    if (!admin || !bcrypt.compareSync(password, admin.password)) {
      return res.status(401).json({ success: false, message: 'Email ou senha invalidos.' });
    }
    const token = jwt.sign({ adminId: admin.id, email: admin.email, role: 'admin' }, SECRET, { expiresIn: '30d' });
    if (req._loginRec) req._loginRec.count = 0;
    res.json({ success: true, token, name: admin.name, email: admin.email });
  } catch (e) {
    console.error('login erro:', e.message);
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  const admin = await get('SELECT id, name, email, created_at FROM admins WHERE id = ?', [req.admin.adminId]);
  if (!admin) return res.status(404).json({ success: false, message: 'Admin nao encontrado.' });
  res.json({ success: true, admin });
});

router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ success: false, message: 'Nova senha deve ter no minimo 6 caracteres.' });
    }
    const admin = await get('SELECT * FROM admins WHERE id = ?', [req.admin.adminId]);
    if (!admin || !bcrypt.compareSync(current_password || '', admin.password)) {
      return res.status(400).json({ success: false, message: 'Senha atual incorreta.' });
    }
    await run('UPDATE admins SET password = ? WHERE id = ?', [bcrypt.hashSync(new_password, 10), admin.id]);
    res.json({ success: true, message: 'Senha alterada com sucesso.' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erro interno.' });
  }
});

module.exports = router;
module.exports.authenticate = authenticate;
module.exports.SECRET = SECRET;
