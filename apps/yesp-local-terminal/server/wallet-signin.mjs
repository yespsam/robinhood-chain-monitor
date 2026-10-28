import QRCode from 'qrcode';
import { isOfficialSigninUrl } from '../extension/signin-policy.js';

// Encode exactly the same URL as the official CLI's --image flow, entirely on
// this machine. Pairing data is returned to the requesting page, never saved.
export async function signinDisplay(data, { encode = QRCode.toDataURL, clock = Date.now } = {}) {
  if (!data?.urlForWeb) return data;
  if (!isOfficialSigninUrl(data.urlForWeb)) throw Object.assign(new Error('Unreviewed sign-in URL.'), { code: 'AUTH_URL_REVIEW_REQUIRED' });
  if (!Number.isSafeInteger(Number(data.expireAt)) || Number(data.expireAt) <= clock())
    throw Object.assign(new Error('Sign-in code expired.'), { code: 'QR_CODE_EXPIRED' });
  try {
    const qrImage = await encode(data.urlForWeb, { type: 'image/png', width: 320, margin: 4, errorCorrectionLevel: 'M' });
    return { ...data, qrImage };
  } catch {
    // An unusually long URL may exceed QR capacity. The original link remains usable.
    return { ...data, qrUnavailable: true };
  }
}
