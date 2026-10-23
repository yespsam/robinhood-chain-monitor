import qrcode from './vendor/qrcode.mjs';
import { stringToBytes } from './vendor/qrcode_UTF8.mjs';

qrcode.stringToBytes = stringToBytes;
const officialHosts = new Set(['web3.binance.com', 'www.binance.com', 'app.binance.com']);

// Match the official CLI: encode urlForWeb verbatim, including every query byte.
// No external QR service, URL fetch, storage, or credential-bearing error text.
export function authQrMatrix(value) {
  try {
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || !officialHosts.has(url.hostname) || url.username || url.password || url.port || url.hash) throw new Error();
    const qr = qrcode(0, 'M');
    qr.addData(value, 'Byte');
    qr.make();
    const size = qr.getModuleCount();
    return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
  } catch { throw new Error('AUTH_QR_UNAVAILABLE'); }
}

export async function renderAuthQr(canvas, value) {
  const matrix = authQrMatrix(value), margin = 4;
  const scale = Math.max(4, Math.ceil(256 / (matrix.length + margin * 2)));
  canvas.width = canvas.height = (matrix.length + margin * 2) * scale;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('AUTH_QR_UNAVAILABLE');
  context.imageSmoothingEnabled = false;
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#000000';
  for (let row = 0; row < matrix.length; row++) for (let col = 0; col < matrix.length; col++) {
    if (matrix[row][col]) context.fillRect((col + margin) * scale, (row + margin) * scale, scale, scale);
  }
}
