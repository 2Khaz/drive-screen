import { audioRange } from './audio-range.js';

const scope = new URL(self.registration.scope);
const audioPrefix = scope.pathname + '__audio/';
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

async function authorization(clientId, fileId, refresh = false) {
  if (!clientId) throw new Error('missing client');
  const client = await self.clients.get(clientId);
  if (!client) throw new Error('missing client');
  const url = new URL(client.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) throw new Error('wrong client scope');
  const value = await new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('auth timeout')); }, 15000);
    channel.port1.onmessage = event => {
      clearTimeout(timer); channel.port1.close();
      const data = event.data;
      if (typeof data?.token !== 'string' || !Number.isSafeInteger(data.size) || data.size <= 0 || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) reject(new Error('not authorized'));
      else resolve(data);
    };
    client.postMessage({ type: 'drive-audio-auth', fileId, refresh }, [channel.port2]);
  });
  return value;
}

async function audioResponse(request, clientId, fileId) {
  try {
    let auth = await authorization(clientId, fileId);
    const range = audioRange(request.headers.get('range'), auth.size);
    if (!range) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${auth.size}`, 'cache-control': 'no-store' } });
    const headers = new Headers({ 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'cache-control': 'private, no-store', 'content-length': String(range.end - range.start + 1), 'x-content-type-options': 'nosniff' });
    if (range.partial) headers.set('content-range', `bytes ${range.start}-${range.end}/${auth.size}`);
    if (request.method === 'HEAD') return new Response(null, { status: range.partial ? 206 : 200, headers });
    const base = /^\d+\.discordsays\.com$/.test(scope.hostname) ? scope.origin + '/gdrive' : 'https://www.googleapis.com';
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${base}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers: { authorization: `Bearer ${auth.token}`, range: `bytes=${range.start}-${range.end}` }, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: request.signal });
      if (response.status === 401 && attempt === 0) { await response.body?.cancel(); auth = await authorization(clientId, fileId, true); continue; }
      if (response.status !== 206) { await response.body?.cancel(); return new Response('오디오를 읽지 못했습니다.', { status: response.status >= 400 ? response.status : 502, headers: { 'cache-control': 'no-store' } }); }
      // Google does not expose Content-Range through CORS. Its validated byte
      // range is reconstructed from authenticated file metadata, including the
      // two-byte probes Safari sends before starting native media playback.
      return new Response(response.body, { status: range.partial ? 206 : 200, headers });
    }
  } catch { return new Response('오디오 인증을 확인해 주세요.', { status: 401, headers: { 'cache-control': 'no-store' } }); }
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(audioPrefix)) return;
  const match = /^([\w-]{1,128})\.mp3$/.exec(url.pathname.slice(audioPrefix.length));
  if (!match || !['GET', 'HEAD'].includes(event.request.method)) { event.respondWith(new Response(null, { status: 404 })); return; }
  event.respondWith(audioResponse(event.request, event.clientId, match[1]));
});
