// Contorno para o bug do whatsapp-web.js ao enviar midia (imagem/video):
// "Data passed to getter must include an id property (it's how we memoize) but got undefined"
// O __x_id interno do MediaData colide com o id da mensagem ao montar o Msg.
// Referencia: https://github.com/wwebjs/whatsapp-web.js/issues/201922
// Roda automaticamente no postinstall para sobreviver a um novo `npm install`.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');

try {
  if (!fs.existsSync(file)) {
    console.log('[patch-wwebjs] Utils.js nao encontrado (ignorando).');
    process.exit(0);
  }
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes('delete message.__x_id')) {
    console.log('[patch-wwebjs] patch de midia ja aplicado.');
    process.exit(0);
  }
  const marker = '            ...extraOptions,\n        };\n';
  if (!src.includes(marker)) {
    console.log('[patch-wwebjs] marcador nao encontrado (ignorando).');
    process.exit(0);
  }
  const patch =
    '\n        // Corrige o envio de midia (whatsapp-web.js#201922): o __x_id do\n' +
    '        // MediaData colide com o id interno da mensagem.\n' +
    '        if (message.__x_id) {\n' +
    '            delete message.__x_id;\n' +
    '        }\n';
  src = src.replace(marker, marker + patch);
  fs.writeFileSync(file, src);
  console.log('[patch-wwebjs] patch de midia aplicado.');
} catch (e) {
  // Nunca quebra o npm install por causa do patch.
  console.error('[patch-wwebjs] falhou:', e.message);
}
