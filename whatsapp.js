// Integracao WhatsApp via whatsapp-web.js (mesmo padrao do Agro-Acontece / Paralelo)
// A sessao fica salva em disco (whatsapp-session). Escaneia o QR uma vez.
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

// Tempo maximo para o client.initialize() resolver (page.goto as vezes trava).
const INIT_TIMEOUT_MS = Number(process.env.WA_INIT_TIMEOUT_MS || 90000);
// Se o app-state sync do WhatsApp Web nao disparar, forcamos a mao.
const READY_WATCHDOG_MS = Number(process.env.WA_READY_WATCHDOG_MS || 20000);
// Verificacao periodica: o Chrome pode morrer e o wwebjs nao avisa ninguem.
const HEALTH_CHECK_MS = Number(process.env.WA_HEALTH_CHECK_MS || 45000);
const MAX_INIT_ATTEMPTS = 3;

// Erros que significam "a pagina/aba morreu" e nao "o envio deu errado".
const STALE_ERROR_RE =
  /detached Frame|Target closed|Session closed|Execution context was destroyed|Protocol error|ProtocolError|browser has disconnected|Connection closed|Cannot read properties of null/i;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
    this.attempt = 0;
    this.syncPokes = 0;
    this.readyWatchdog = null;
    this.healthTimer = null;
    this.retryTimer = null;
    this.recovering = null;
    this.connecting = null;
    this.destroying = false;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.attempt = 0;
    this.qrCodeBase64 = null;
    this.lastError = null;
    this.status = 'initializing';
    await this.connect();
  }

  // Serializa as tentativas de conexao (duas ao mesmo tempo orfanam o Chrome).
  async connect() {
    if (!this.started) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  // Cria o client e tenta inicializar. Se travar, limpa tudo e tenta de novo.
  async doConnect() {
    if (!this.started) return;
    this.attempt += 1;
    const attempt = this.attempt;
    this.status = this.status === 'qr' ? 'qr' : 'initializing';
    this.removeSingletonLocks();

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.sessionDir }),
      puppeteer: {
        headless: true,
        protocolTimeout: 180000,
        dumpio: String(process.env.WA_DUMPIO || '') === '1',
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

    const client = this.client;

    client.on('qr', async (qr) => {
      this.status = 'qr';
      try {
        this.qrCodeBase64 = await qrcode.toDataURL(qr);
      } catch (e) {}
    });

    client.on('ready', () => {
      this.status = 'ready';
      this.ready = true;
      this.attempt = 0;
      this.qrCodeBase64 = null;
      this.lastError = null;
      this.stopReadyWatchdog();
      try {
        this.phoneNumber = client.info && client.info.wid ? client.info.wid.user : null;
      } catch (e) {}
      this.startHealthCheck();
      console.log('[whatsapp] conectado: ' + this.phoneNumber);
    });

    client.on('auth_failure', (m) => {
      this.status = 'error';
      this.ready = false;
      this.lastError = String(m);
      this.stopReadyWatchdog();
      this.stopHealthCheck();
    });

    client.on('disconnected', (r) => {
      if (this.client !== client || this.destroying || this.recovering) return;
      const reason = String(r);
      this.ready = false;
      this.lastError = reason;
      this.stopReadyWatchdog();
      this.stopHealthCheck();
      if (reason === 'LOGOUT') {
        this.status = 'disconnected';
        this.started = false;
        this.client = null;
        console.log('[whatsapp] sessao encerrada (logout). Escaneie o QR Code no painel.');
        return;
      }
      this.status = 'disconnected';
      console.log('[whatsapp] desconectado (' + reason + '); reconectando...');
      this.recover('desconectado: ' + reason).catch(() => {});
    });

    let timer = null;
    try {
      await Promise.race([
        client.initialize(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timeout ao iniciar o WhatsApp (' + Math.round(INIT_TIMEOUT_MS / 1000) + 's)')),
            INIT_TIMEOUT_MS
          );
        }),
      ]);
      this.startReadyWatchdog();
      // Se o Chrome fechar, o wwebjs nao avisa: escutamos direto no puppeteer.
      if (client.pupBrowser) {
        client.pupBrowser.on('disconnected', () => {
          if (this.destroying) return;
          if (this.client !== client || !this.started || this.recovering) return;
          this.recover('navegador fechou').catch(() => {});
        });
      }
    } catch (err) {
      this.status = 'error';
      this.lastError = err && (err.stack || err.message) ? err.stack || err.message : String(err);
      console.error('[whatsapp] erro ao iniciar (tentativa ' + attempt + '):', this.lastError);
      await this.destroyClient(client);
      if (this.started && attempt < MAX_INIT_ATTEMPTS) {
        const delay = 5000 * attempt;
        console.log('[whatsapp] nova tentativa em ' + delay / 1000 + 's');
        this.retryTimer = setTimeout(() => this.connect(), delay);
      } else if (this.started) {
        console.error('[whatsapp] desistindo apos ' + attempt + ' tentativas; nova rodada em 120s');
        this.retryTimer = setTimeout(() => {
          this.attempt = 0;
          this.connect();
        }, 120000);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Bug conhecido: se o app-state sync do WhatsApp Web termina antes do
  // whatsapp-web.js expor window.onAppStateHasSyncedEvent, o evento `ready`
  // nunca e emitido (o socket fica CONNECTED para sempre). Aqui detectamos
  // esse caso e chamamos a funcao manualmente.
  startReadyWatchdog() {
    this.stopReadyWatchdog();
    this.syncPokes = 0;
    this.readyWatchdog = setInterval(() => {
      if (this.ready || !this.client) {
        this.stopReadyWatchdog();
        return;
      }
      if (this.syncPokes >= 10) return;
      this.pokeAppStateSync().catch(() => {});
    }, READY_WATCHDOG_MS);
  }

  stopReadyWatchdog() {
    if (this.readyWatchdog) {
      clearInterval(this.readyWatchdog);
      this.readyWatchdog = null;
    }
  }

  async pokeAppStateSync() {
    const client = this.client;
    if (!client || !client.pupPage) return false;
    const info = await client.pupPage.evaluate(() => {
      const out = { state: null, injected: false, syncFn: null };
      try {
        out.state = window.require('WAWebSocketModel').Socket.state;
      } catch (e) {}
      try {
        out.injected = typeof window.WWebJS !== 'undefined';
      } catch (e) {}
      try {
        out.syncFn = typeof window.onAppStateHasSyncedEvent;
      } catch (e) {}
      return out;
    });
    if (!info || info.state !== 'CONNECTED' || !info.injected || info.syncFn !== 'function') {
      return false;
    }
    this.syncPokes += 1;
    console.log(
      '[whatsapp] app-state sync nao disparou; forcando ready (tentativa ' + this.syncPokes + ')'
    );
    await client.pupPage.evaluate(() => {
      window.onAppStateHasSyncedEvent();
    });
    return true;
  }

  // O Chrome pode morrer (ou a aba ser recarregada) sem o wwebjs emitir nada.
  // Sem isso, o painel fica "ready" para sempre e todo envio falha.
  startHealthCheck() {
    this.stopHealthCheck();
    this.healthTimer = setInterval(() => {
      this.checkHealth().catch(() => {});
    }, HEALTH_CHECK_MS);
  }

  stopHealthCheck() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  async checkHealth() {
    const client = this.client;
    if (!this.ready || !client || !this.started) return;
    const browser = client.pupBrowser;
    if (browser && typeof browser.isConnected === 'function' && !browser.isConnected()) {
      return this.recover('navegador desconectado');
    }
    try {
      const state = await client.pupPage.evaluate(() => {
        const out = { readyState: document.readyState, socket: null };
        try {
          out.socket = window.require('WAWebSocketModel').Socket.state;
        } catch (e) {}
        return out;
      });
      if (!state || !state.readyState) throw new Error('pagina sem readyState');
      if (state.socket && state.socket !== 'CONNECTED') {
        return this.recover('socket ' + state.socket);
      }
    } catch (e) {
      return this.recover('health check falhou: ' + (e && e.message ? e.message : e));
    }
  }

  // Fecha o client atual e abre outro, mantendo a sessao salva em disco.
  recover(reason) {
    if (this.recovering) return this.recovering;
    if (!this.started) return Promise.resolve(false);
    console.log('[whatsapp] recuperando conexao (' + reason + ')');
    this.ready = false;
    this.status = 'initializing';
    this.stopReadyWatchdog();
    this.stopHealthCheck();
    const client = this.client;
    this.recovering = (async () => {
      try {
        await this.destroyClient(client);
        this.attempt = 0;
        if (this.started) await this.connect();
      } finally {
        this.recovering = null;
      }
      return true;
    })();
    return this.recovering;
  }

  isStaleError(err) {
    const msg = String((err && err.message) || err || '');
    return STALE_ERROR_RE.test(msg);
  }

  waitReady(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.ready) return resolve(true);
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (this.ready) {
          clearInterval(iv);
          resolve(true);
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(iv);
          reject(new Error('WhatsApp reconectando. Tente enviar novamente em instantes.'));
        }
      }, 1000);
    });
  }

  // Executa o envio; se a pagina tiver morrido, reinicia e tenta uma vez mais.
  async withRecovery(label, fn) {
    try {
      return await fn();
    } catch (err) {
      if (!this.isStaleError(err)) throw err;
      console.log(
        '[whatsapp] ' + label + ' falhou (' + (err.message || err) + '); reiniciando conexao'
      );
      await this.recover('envio falhou: ' + (err.message || err));
      await this.waitReady(120000);
      return await fn();
    }
  }

  removeSingletonLocks() {
    const dir = path.join(this.sessionDir, 'session');
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch (e) {}
    }
  }

  async destroyClient(client) {
    this.stopReadyWatchdog();
    this.stopHealthCheck();
    const target = client || this.client;
    if (!target) return;
    this.destroying = true;
    try {
      await Promise.race([target.destroy(), sleep(10000)]);
    } catch (e) {
    } finally {
      this.destroying = false;
    }
    if (this.client === target) this.client = null;
    // Da tempo do Chrome liberar o perfil antes da proxima tentativa.
    await sleep(1500);
    this.removeSingletonLocks();
  }

  async stop(cleanSession = false) {
    this.started = false;
    this.recovering = null;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    await this.destroyClient(this.client);
    this.ready = false;
    this.status = 'stopped';
    this.qrCodeBase64 = null;
    this.attempt = 0;
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
    const chatId = this.chatId(number);
    return await this.withRecovery('envio de texto', () => this.client.sendMessage(chatId, text));
  }

  chatId(number) {
    let digits = String(number || '').replace(/\D/g, '');
    if (!digits) throw new Error('Numero invalido');
    if (digits.length <= 11) digits = '55' + digits;
    return digits + '@c.us';
  }

  // Envia uma imagem (Buffer) com legenda opcional.
  async sendImage(number, buffer, filename, caption) {
    if (!this.ready || !this.client) {
      throw new Error('WhatsApp nao conectado. Escaneie o QR Code no painel.');
    }
    const { MessageMedia } = require('whatsapp-web.js');
    const media = new MessageMedia(
      'image/png',
      Buffer.from(buffer).toString('base64'),
      filename || 'imagem.png'
    );
    return await this.withRecovery('envio de imagem', () =>
      this.client.sendMessage(this.chatId(number), media, caption ? { caption } : {})
    );
  }
}

module.exports = new WhatsAppBot();
