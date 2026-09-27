import { randomBytes, timingSafeEqual } from 'node:crypto';

const ERRORS = Object.freeze({ invalid_key: [400, '请只粘贴完整的广场 API 密钥，不要包含说明文字或换行。'], already_saved: [409, '本机已有密钥。如需更换，请勾选替换确认后重新粘贴。'], unsafe_storage: [503, '密钥目录或文件权限异常，未保存。请检查本机配置权限。'] });
const reply = (response, body, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
};

export function createSquareKeyRoute(store) {
  const csrf = randomBytes(32).toString('hex');
  return async (request, response, url) => {
    if (url.pathname !== '/api/square-key') return false;
    const deny = (status, error) => { reply(response, { error }, status); return true; };
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)
        || (request.headers.origin && request.headers.origin !== url.origin)
        || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) return deny(403, '仅允许本机同源访问');
    if (url.search) return deny(400, '此接口不接受 URL 参数');
    if (!['GET', 'POST'].includes(request.method)) return deny(405, '仅支持读取状态或保存密钥');
    try {
      if (request.method === 'GET') { reply(response, { ...await store.status(), csrfToken: csrf }); return true; }
      // Require both an exact Origin and an unpredictable per-process token.
      // Cross-site forms/fetches must never change a saved credential.
      const token = Buffer.from(String(request.headers['x-yesp-csrf'] || ''));
      if (request.headers.origin !== url.origin || token.length !== csrf.length || !timingSafeEqual(token, Buffer.from(csrf))) return deny(403, '页面验证已失效，请刷新后重试');
      if (String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return deny(415, '需要 JSON 请求');
      if (request.headers['content-encoding']) return deny(415, '不支持压缩请求');
      let body = '', size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8192) return deny(413, '输入过长，未保存');
        body += chunk;
      }
      let payload;
      try { payload = JSON.parse(body); } catch { return deny(400, '输入格式无效，未保存'); }
      if (!payload || Array.isArray(payload) || typeof payload !== 'object' || typeof payload.key !== 'string'
          || (payload.replace !== undefined && typeof payload.replace !== 'boolean')
          || Object.keys(payload).some(key => !['key', 'replace'].includes(key))) return deny(400, '输入格式无效，未保存');
      reply(response, await store.save(payload.key, { replace: payload.replace === true }));
    } catch (error) {
      const [status, message] = ERRORS[error.code] || [503, '本机配置暂不可用，无法确认是否保存。请刷新状态后重试。'];
      // Never echo provider, filesystem or request errors that may contain keys.
      reply(response, { error: message }, status);
    }
    return true;
  };
}
