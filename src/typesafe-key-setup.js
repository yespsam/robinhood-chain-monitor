// Loopback-only, single-use key form. No external network or request logging.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { saveTypesafeKey, validTypesafeKey } from './typesafe-local-key.js';

export async function startTypesafeKeySetup({ saveKey = saveTypesafeKey, lifetimeMs = 15 * 60_000 } = {}) {
  const nonce = randomBytes(32).toString('hex'), formPath = `/setup/${nonce}`, donePath = `/done/${nonce}`;
  let origin, saved = false, busy = false, expires;
  const html = content => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jev 本地密钥设置</title><style>body{background:#10151d;color:#e8eef8;font:16px/1.7 system-ui;margin:64px auto;padding:24px;max-width:600px}h1{font-size:26px}p{color:#b6c4d6}input,button{box-sizing:border-box;width:100%;padding:14px;margin:10px 0;border-radius:8px;font:inherit}input{background:#1b2533;color:white;border:1px solid #4a596d}button{background:#77d8c5;color:#10151d;border:0;cursor:pointer}small{color:#9ba9ba}</style><main>${content}</main></html>`;
  // WebKit can turn same-origin form POST Origin into "null" under no-referrer.
  // same-origin still sends no referrer to other origins, and preserves the
  // Origin signal required by the strict CSRF check below. Never allow null.
  const headers = { 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
  const respond = (res, status, content) => { res.writeHead(status, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }); res.end(html(content)); };
  const server = http.createServer(async (req, res) => {
    if (req.headers.host !== new URL(origin).host) return respond(res, 403, '<h1>请求来源不符</h1>');
    if (req.method === 'GET' && req.url === donePath && saved) return respond(res, 200,
      '<h1>密钥已保存到本地</h1><p>未显示或发送给第三方，也没有启动交易。回到对话告诉我“已保存”，即可继续一次性 Jev 测试。</p>');
    if (req.method === 'GET' && req.url === formPath && !saved) return respond(res, 200,
      `<h1>Jev 本地密钥设置</h1><p>请先在 TypeSafe 撤销刚才出现在工具记录中的旧密钥，再创建新密钥。只在下方粘贴新密钥，不要发到聊天。</p><form method="post" action="${formPath}" autocomplete="off"><label for="key">新的 TypeSafe API Key</label><input id="key" name="key" type="password" autocomplete="new-password" required minlength="20" maxlength="256" spellcheck="false"><button type="submit">仅保存到本地</button></form><small>仅监听 127.0.0.1，15 分钟后失效。写入项目中被 Git 忽略的 .env.typesafe.local，文件权限为仅当前用户读写。不会充值、开自动扣费或操作钱包。</small>`);
    if (req.method !== 'POST' || req.url !== formPath) return respond(res, 404, '<h1>页面不存在或已失效</h1>');
    if (req.headers.origin !== origin || !String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')
      || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return respond(res, 403, '<h1>请求来源不符</h1>');
    if (saved || busy) return respond(res, 409, '<h1>入口已使用或正在保存</h1>');
    busy = true;
    try {
      let body = '', bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 2048) { respond(res, 413, '<h1>输入过长</h1>'); return; } body += chunk.toString('utf8'); }
      const fields = new URLSearchParams(body), key = fields.get('key')?.trim();
      if (fields.getAll('key').length !== 1 || !validTypesafeKey(key)) return respond(res, 400, '<h1>密钥格式不正确</h1><p>请返回设置页重新输入；此页面不会回显输入。</p>');
      await saveKey(key); saved = true;
      res.writeHead(303, { ...headers, Location: donePath }); res.end();
    } catch { if (!res.headersSent) respond(res, 500, '<h1>保存失败</h1><p>未显示密钥，请检查本地文件权限。</p>'); }
    finally { busy = false; }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const close = () => { clearTimeout(expires); server.close(); server.closeAllConnections(); };
  expires = setTimeout(close, lifetimeMs); expires.unref();
  return { url: `${origin}${formPath}`, origin, close, isSaved: () => saved };
}
