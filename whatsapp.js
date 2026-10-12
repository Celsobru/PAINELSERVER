// Integracao WhatsApp via whatsapp-web.js (mesmo padrao do Agro-Acontece / Paralelo)
// A sessao fica salva em disco (whatsapp-session). Escaneia o QR uma vez.
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

class WhatsAppBot {
  constructor() {
    this.client = null;
    this.qrCodeBase64 = null;
    this.status = 'stopped'; // stopped | initializing | qr | ready | disconnected | error
    this.phoneNumber = null;
    this.ready = false;
    this.lastError = null;
    this.started = false;
    this.sessionDir = path.join(__dirname, 'whatsapp-session');
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.qrCodeBase64 = null;
    this.status = 'initializing';

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.sessionDir }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
        ],
      },
    });

    this.client.on('qr', async (qr) => {
      this.status = 'qr';
      try {
        this.qrCodeBase64 = await qrcode.toDataURL(qr);
      } catch (e) {}
    });

    this.client.on('ready', () => {
      this.status = 'ready';
      this.ready = true;
      this.qrCodeBase64 = null;
      try {
        this.phoneNumber = this.client.info && this.client.info.wid ? this.client.info.wid.user : null;
      } catch (e) {}
      console.log('[whatsapp] conectado: ' + this.phoneNumber);
    });

    this.client.on('auth_failure', (m) => {
      this.status = 'error';
      this.ready = false;
      this.lastError = String(m);
    });

    this.client.on('disconnected', (r) => {
      this.status = 'disconnected';
      this.ready = false;
      this.lastError = String(r);
      this.started = false;
      this.client = null;
    });

    try {
      await this.client.initialize();
    } catch (err) {
      this.status = 'error';
      this.lastError = err && (err.stack || err.message) ? err.stack || err.message : String(err);
      this.started = false;
      this.client = null;
      console.error('[whatsapp] erro ao iniciar:', this.lastError);
    }
  }

  async stop(cleanSession = false) {
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (e) {}
    }
    this.client = null;
    this.ready = false;
    this.started = false;
    this.status = 'stopped';
    this.qrCodeBase64 = null;
    if (cleanSession) {
      try {
        if (fs.existsSync(this.sessionDir)) fs.rmSync(this.sessionDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }

  async restart(cleanSession = false) {
    await this.stop(cleanSession);
    await this.start();
  }

  getStatus() {
    return {
      status: this.status,
      qrCode: this.qrCodeBase64,
      phoneNumber: this.phoneNumber,
      ready: this.ready,
      error: this.lastError,
    };
  }

  async sendMessage(number, text) {
    if (!this.ready || !this.client) {
      throw new Error('WhatsApp nao conectado. Escaneie o QR Code no painel.');
    }
    let digits = String(number || '').replace(/\D/g, '');
    if (!digits) throw new Error('Numero invalido');
    if (digits.length <= 11) digits = '55' + digits;
    const chatId = digits + '@c.us';
    return await this.client.sendMessage(chatId, text);
  }
}

module.exports = new WhatsAppBot();
