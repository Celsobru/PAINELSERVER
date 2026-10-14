// Cliente da API do C6 Bank (BaaS) para Pix.
// Autenticacao: mTLS (certificado PKCS12) + OAuth2 client_credentials em POST /v1/auth.
// Envs esperadas (no .env da VPS, NUNCA no repositorio):
//   C6_CLIENT_ID, C6_CLIENT_SECRET
//   C6_CERT_PATH (caminho do .pfx/.p12), C6_CERT_PASSPHRASE
//   C6_PIX_KEY (chave Pix recebedora)
//   C6_BASE_URL (default sandbox), C6_WEBHOOK_TOKEN (validacao do webhook)
const fs = require('fs');
const https = require('https');
const { URL } = require('url');

const BASE_URL = process.env.C6_BASE_URL || 'https://baas-api-sandbox.c6bank.info';

let cachedAgent = null;
function agent() {
  if (cachedAgent) return cachedAgent;
  const pfxPath = process.env.C6_CERT_PATH;
  if (!pfxPath || !fs.existsSync(pfxPath)) return null;
  cachedAgent = new https.Agent({
    pfx: fs.readFileSync(pfxPath),
    passphrase: process.env.C6_CERT_PASSPHRASE || undefined,
    keepAlive: true,
  });
  return cachedAgent;
}

function configured() {
  return !!(
    process.env.C6_CLIENT_ID &&
    process.env.C6_CLIENT_SECRET &&
    process.env.C6_CERT_PATH &&
    fs.existsSync(process.env.C6_CERT_PATH)
  );
}

function http(method, pathname, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(BASE_URL + pathname);
    const a = agent();
    if (!a) return reject(new Error('Certificado C6 nao configurado (C6_CERT_PATH)'));
    const data = o.body ? JSON.stringify(o.body) : null;
    const req = https.request({
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      agent: a,
      headers: Object.assign(
        {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {},
        o.token ? { Authorization: 'Bearer ' + o.token } : {},
        o.headers || {}
      ),
    }, (res) => {
      let chunks = '';
      res.on('data', (d) => { chunks += d; });
      res.on('end', () => {
        let json = null;
        try { json = chunks ? JSON.parse(chunks) : null; } catch (e) { json = { raw: chunks }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let tokenCache = { token: null, exp: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const r = await http('POST', '/v1/auth', {
    body: {
      grant_type: 'client_credentials',
      client_id: process.env.C6_CLIENT_ID,
      client_secret: process.env.C6_CLIENT_SECRET,
    },
  });
  if (r.status >= 300 || !r.body || !r.body.access_token) {
    throw new Error('Falha na autenticacao C6 (' + r.status + '): ' + JSON.stringify(r.body).slice(0, 300));
  }
  tokenCache = { token: r.body.access_token, exp: Date.now() + (Number(r.body.expires_in || 3600) * 1000) };
  return tokenCache.token;
}

async function api(method, pathname, body) {
  const token = await getToken();
  const r = await http(method, pathname, { body, token });
  if (r.status >= 400) {
    throw new Error('C6 ' + r.status + ': ' + JSON.stringify(r.body).slice(0, 400));
  }
  return r.body;
}

function pixKey() { return process.env.C6_PIX_KEY || ''; }

function configured_ok() { return configured() && !!pixKey(); }

// Cobranca Pix imediata (com txid opcional). Retorna { txid, status, pixCopiaECola, location }
async function createImmediateCharge(opts) {
  const o = opts || {};
  const body = {
    calendario: { expiracao: 60 * 60 * 24 * 30 },
    valor: { original: (Number(o.amountCents || 0) / 100).toFixed(2) },
    chave: pixKey(),
  };
  if (o.txid) body.txid = String(o.txid);
  if (o.description) body.solicitacaoPagador = String(o.description).slice(0, 140);
  const path = o.txid ? '/v2/pix/cob/' + encodeURIComponent(o.txid) : '/v2/pix/cob';
  return api('PUT', path, body);
}

async function getChargeByTxid(txid) {
  return api('GET', '/v2/pix/cob/' + encodeURIComponent(txid));
}

// Cadastra a URL de webhook para a chave Pix (BACEN). url deve ser HTTPS publica.
async function setPixWebhook(url) {
  const chave = pixKey();
  if (!chave) throw new Error('C6_PIX_KEY nao configurada');
  return api('PUT', '/v2/pix/webhook/' + encodeURIComponent(chave), { webhookUrl: url });
}

module.exports = {
  configured,
  configured_ok,
  getToken,
  createImmediateCharge,
  getChargeByTxid,
  setPixWebhook,
  pixKey,
};
