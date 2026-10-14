// Gerador de Pix "Copia e Cola" (BR Code / padrao EMV do Banco Central).
// Sem dependencia externa. Usado para montar a cobranca quando a API do banco
// (C6) ainda nao esta configurada ou falha.

function onlyAscii(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

function sanitize(s, max) {
  const t = onlyAscii(s).replace(/\s+/g, ' ');
  return max ? t.slice(0, max) : t;
}

function tlv(id, value) {
  const v = String(value === undefined || value === null ? '' : value);
  return id + String(v.length).padStart(2, '0') + v;
}

// CRC16/CCITT-FALSE (obrigatorio no fim do BR Code)
function crc16(payload) {
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function normalizeTxid(txid) {
  const t = String(txid || '').replace(/[^A-Za-z0-9]/g, '');
  return t ? t.slice(0, 25) : '***';
}

// Monta o BR Code. amountCents opcional (sem valor = o pagador digita).
function buildPix(opts) {
  const o = opts || {};
  const key = String(o.key || '').trim();
  if (!key) throw new Error('Chave Pix nao configurada');

  const nome = sanitize(o.name || 'RECEBEDOR', 25) || 'RECEBEDOR';
  const cidade = sanitize(o.city || 'CIDADE', 15) || 'CIDADE';
  const descricao = sanitize(o.description, 40);
  const txid = normalizeTxid(o.txid);
  const valor = o.amountCents ? (Number(o.amountCents) / 100).toFixed(2) : '';

  let mai = tlv('00', 'br.gov.bcb.pix') + tlv('01', key);
  if (descricao) mai += tlv('02', descricao);

  let payload = '';
  payload += tlv('00', '01');          // Payload Format Indicator
  payload += tlv('01', '01');          // Point of Initiation (estatico)
  payload += tlv('26', mai);           // Merchant Account Information (Pix)
  payload += tlv('52', '0000');        // Merchant Category Code
  payload += tlv('53', '986');         // Moeda (BRL)
  if (valor) payload += tlv('54', valor); // Valor
  payload += tlv('58', 'BR');          // Pais
  payload += tlv('59', nome);          // Nome do recebedor
  payload += tlv('60', cidade);        // Cidade do recebedor
  payload += tlv('62', tlv('05', txid)); // Dados adicionais (txid)
  payload += '6304';                   // CRC
  payload += crc16(payload);
  return payload;
}

module.exports = { buildPix, crc16, sanitize };
