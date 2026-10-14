require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const db = require('./db');
const whatsapp = require('./whatsapp');

const app = express();
const PORT = process.env.PORT || 3010;
const BASE = process.env.BASE_PATH || '/painelserver';

// CORS: por padrao apenas mesma origem. Configure ALLOWED_ORIGINS (separadas por virgula) se precisar.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // mesma origem / server-to-server
    if (ALLOWED_ORIGINS.length === 0) return cb(null, false);
    return cb(null, ALLOWED_ORIGINS.includes(origin));
  },
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ---- API ----
app.use(BASE + '/api/auth', require('./routes/auth'));
app.use(BASE + '/api/clients', require('./routes/clients'));
app.use(BASE + '/api/sites', require('./routes/sites'));
app.use(BASE + '/api/charges', require('./routes/charges'));
app.use(BASE + '/api/notifications', require('./routes/notifications'));
app.use(BASE + '/api/dashboard', require('./routes/dashboard'));
app.use(BASE + '/api/whatsapp', require('./routes/whatsapp'));
app.use(BASE + '/api/webhooks', require('./routes/webhooks'));
app.use(BASE + '/api/config', require('./routes/config'));

app.get(BASE + '/api/status', (req, res) => {
  res.json({ status: 'online', service: 'painelserver', version: '1.0.0', timestamp: new Date().toISOString() });
});

// ---- Front ----
app.use(BASE, express.static(path.join(__dirname, 'public')));
app.get(BASE, (req, res) => res.redirect(BASE + '/'));
app.get(BASE + '/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/', (req, res) => res.redirect(BASE + '/'));

(async () => {
  await db.init();
  app.listen(PORT, () => {
    console.log('[painelserver] ouvindo em http://localhost:' + PORT + BASE);
  });
  if (String(process.env.WHATSAPP_ENABLED || 'true') !== 'false') {
    whatsapp.start().catch((e) => console.error('[whatsapp] start falhou:', e && e.message));
  }
  // Agendador de lembretes (uma vez por dia, conforme Configuracoes)
  try {
    require('./scheduler').start();
  } catch (e) {
    console.error('[scheduler] falhou ao iniciar:', e && e.message);
  }
})();
