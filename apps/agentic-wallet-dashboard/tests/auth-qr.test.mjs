import test from 'node:test';
import assert from 'node:assert/strict';
import { authQrMatrix, renderAuthQr } from '../public/auth-qr.js';
const link = 'https://app.binance.com/synthetic-login?url=a%2Fb%2B%3D&expireAt=1800000000000';
test('QR uses exact input bytes rather than parsing or rebuilding the authentication query', () => {
  const original = authQrMatrix(link), changed = authQrMatrix(link.replace('%2B', '+'));
  assert.ok(original.length >= 21); assert.equal(original.length % 4, 1);
  assert.ok(original.every(row => row.length === original.length && row.every(value => typeof value === 'boolean')));
  assert.notDeepEqual(original, changed);
});
test('QR rejects nonofficial or malformed URLs without disclosing the original payload', () => {
  for (const bad of ['https://app.binance.com.evil.test/secret', 'http://www.binance.com/secret', 'https://user@www.binance.com/secret', 'https://app.binance.com:9999/secret', 'https://www.binance.com/path#secret', link + '\nsecret']) {
    assert.throws(() => authQrMatrix(bad), { message: 'AUTH_QR_UNAVAILABLE' });
  }
});
test('canvas QR has an opaque white background and a four-module quiet zone', async () => {
  const operations = [], context = { fillStyle: '', fillRect(...rect) { operations.push({ color: this.fillStyle, rect }); } };
  const canvas = { width: 0, height: 0, getContext(kind) { assert.equal(kind, '2d'); return context; } };
  await renderAuthQr(canvas, link); const matrix = authQrMatrix(link), scale = canvas.width / (matrix.length + 8);
  assert.equal(canvas.width, canvas.height); assert.ok(Number.isInteger(scale) && scale >= 4);
  assert.deepEqual(operations[0], { color: '#ffffff', rect: [0, 0, canvas.width, canvas.height] });
  assert.ok(operations.slice(1).every(op => op.color === '#000000' && op.rect[0] >= scale * 4 && op.rect[1] >= scale * 4 && op.rect[0] + scale <= canvas.width - scale * 4 && op.rect[1] + scale <= canvas.height - scale * 4));
});
