import { timingSafeEqual, createHash } from 'node:crypto';
import { createPublicSnapshot } from './public-dashboard-state.js';

const digest = value => createHash('sha256').update(value).digest();
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
} });

// Dependency injection keeps cloud storage/auth independently testable.
export function publicApi({ store, secret, now = Date.now }) {
  return async request => {
    const path = new URL(request.url).pathname;
    if (path === '/api/strategy-state' && request.method === 'GET') {
      try {
        const snapshot = await store.get('snapshot', { type: 'json' });
        return snapshot ? response(snapshot) : response({ status: 'waiting', mode: 'paper', message: '等待本机上传首份公开快照' }, 503);
      } catch { return response({ status: 'unavailable' }, 503); }
    }
    if (path !== '/api/publish-state') return response({ error: '只读站点，无此接口' }, 404);
    if (request.method !== 'POST') return response({ error: '方法不支持' }, 405);
    const authorization = request.headers.get('authorization') || '';
    if (!secret || secret.length < 32 || !timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`))) return response({ error: '未授权' }, 401);
    if (!request.headers.get('content-type')?.startsWith('application/json')) return response({ error: '需要 JSON' }, 415);
    const maxBytes = 2_000_000;
    if (Number(request.headers.get('content-length')) > maxBytes) return response({ error: '请求过大' }, 413);
    let size = 0, chunks = [];
    for await (const chunk of request.body || []) {
      size += chunk.byteLength;
      if (size > maxBytes) return response({ error: '请求过大' }, 413);
      chunks.push(chunk);
    }
    let snapshot;
    try { snapshot = createPublicSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')), now()); }
    catch { return response({ error: '模拟快照格式不符合要求' }, 400); }
    if (now() - Date.parse(snapshot.updatedAt) > 120000) return response({ error: '拒绝过期快照' }, 409);
    try {
      await store.setJSON('snapshot', snapshot);
      return response({ ok: true, sourceUpdatedAt: snapshot.updatedAt });
    } catch { return response({ error: '暂时无法存储快照' }, 503); }
  };
}
