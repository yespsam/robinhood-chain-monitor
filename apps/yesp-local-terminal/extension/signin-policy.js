// Keep the vendor-provided URL intact. Only exact reviewed HTTPS hosts are allowed.
export const OFFICIAL_SIGNIN_HOSTS = Object.freeze(['web3.binance.com', 'www.binance.com', 'app.binance.com']);
export function isOfficialSigninUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
    const url = new URL(value);
    return url.protocol === 'https:' && OFFICIAL_SIGNIN_HOSTS.includes(url.hostname)
      && !url.username && !url.password && !url.port && !url.hash;
  } catch { return false; }
}
