const discordApi = 'https://discord.com/api/v10';
const encoder = new TextEncoder();
let googleCache;
let libraryCache;
let libraryPending;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function encode64(bytes) {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode64(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
}

function randomToken() { return encode64(crypto.getRandomValues(new Uint8Array(32))); }
function now() { return Math.floor(Date.now() / 1000); }
function allowed(env, userId) { return (env.DISCORD_ALLOWED_USERS || '').split(',').map(id => id.trim()).includes(userId); }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }); }

async function readBytes(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '요청 내용이 필요합니다.');
  const chunks = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > 128 * 1024) { await reader.cancel(); throw new HttpError(413, '요청이 너무 큽니다.'); }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function readJson(request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new HttpError(415, 'JSON 요청이 필요합니다.');
  const bytes = await readBytes(request);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(400, '요청 형식을 확인해 주세요.'); }
}

async function hmacKey(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new HttpError(503, '세션 설정이 준비되지 않았습니다.');
  return crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function issueSession(env, user) {
  const header = encode64(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = encode64(encoder.encode(JSON.stringify({ sub: user.id, name: user.name, aud: 'drive-screen', iat: now(), exp: now() + 8 * 3600 })));
  const data = `${header}.${payload}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(env), encoder.encode(data));
  return `${data}.${encode64(new Uint8Array(signature))}`;
}

async function requireUser(request, env) {
  const token = /^Bearer ([\w.-]+)$/.exec(request.headers.get('authorization') || '')?.[1];
  if (!token || token.length > 4096) throw new HttpError(401, 'Discord로 다시 로그인해 주세요.');
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error();
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(env), decode64(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`));
    if (!valid) throw new Error();
    const header = JSON.parse(new TextDecoder().decode(decode64(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(decode64(parts[1])));
    if (header.alg !== 'HS256' || payload.aud !== 'drive-screen' || !Number.isFinite(payload.exp) || payload.exp <= now() || !allowed(env, payload.sub)) throw new Error();
    return { id: payload.sub, name: payload.name };
  } catch { throw new HttpError(401, 'Discord로 다시 로그인해 주세요.'); }
}

async function discordLogin(env, code, redirectUri) {
  if (typeof code !== 'string' || !code || code.length > 512) throw new HttpError(400, 'Discord 인증 코드가 필요합니다.');
  const body = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code });
  if (redirectUri) body.set('redirect_uri', redirectUri);
  const tokenResponse = await fetch(`${discordApi}/oauth2/token`, { method: 'POST', body, signal: AbortSignal.timeout(15000) });
  if (!tokenResponse.ok) { await tokenResponse.body?.cancel(); throw new HttpError(401, 'Discord 인증 코드를 다시 발급받아 주세요.'); }
  const { access_token: accessToken } = await tokenResponse.json();
  const identity = await fetch(`${discordApi}/users/@me`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) });
  if (!identity.ok) { await identity.body?.cancel(); throw new HttpError(502, 'Discord 계정을 확인하지 못했습니다.'); }
  const profile = await identity.json();
  if (!allowed(env, profile.id)) throw new HttpError(403, '이 계정에 시청 권한이 없습니다.');
  const user = { id: profile.id, name: String(profile.global_name || profile.username || '사용자').slice(0, 80) };
  return { user, accessToken };
}

function frontendUrl(env) {
  if (!env.FRONTEND_URL) throw new HttpError(503, '플레이어 주소 설정이 필요합니다.');
  return new URL(env.FRONTEND_URL);
}

async function authStart(url, env) {
  const challenge = url.searchParams.get('challenge');
  if (!/^[\w-]{43}$/.test(challenge || '')) throw new HttpError(400, '로그인 요청을 플레이어에서 다시 시작해 주세요.');
  const state = randomToken();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_flows WHERE expires < ?').bind(now()),
    env.DB.prepare('DELETE FROM login_tickets WHERE expires < ?').bind(now()),
    env.DB.prepare('INSERT INTO oauth_flows (state, challenge, expires) VALUES (?, ?, ?)').bind(state, challenge, now() + 600),
  ]);
  const target = new URL('https://discord.com/oauth2/authorize');
  target.search = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, redirect_uri: `${env.PUBLIC_API_URL}/auth/callback`, response_type: 'code', scope: 'identify', state, prompt: 'consent' });
  return Response.redirect(target.href, 302);
}

async function authCallback(url, env) {
  const state = url.searchParams.get('state');
  if (!/^[\w-]{43}$/.test(state || '')) throw new HttpError(400, '로그인 요청이 올바르지 않습니다.');
  const flow = await env.DB.prepare('DELETE FROM oauth_flows WHERE state = ? AND expires > ? RETURNING challenge').bind(state, now()).first();
  if (!flow) throw new HttpError(400, '로그인 요청이 만료됐거나 이미 사용됐습니다.');
  const target = frontendUrl(env);
  if (url.searchParams.has('error')) { target.hash = 'auth_error=cancelled'; return Response.redirect(target.href, 302); }
  try {
    const { user } = await discordLogin(env, url.searchParams.get('code'), `${env.PUBLIC_API_URL}/auth/callback`);
    const ticket = randomToken();
    await env.DB.prepare('INSERT INTO login_tickets (ticket, challenge, user_id, user_name, expires) VALUES (?, ?, ?, ?, ?)').bind(ticket, flow.challenge, user.id, user.name, now() + 120).run();
    target.hash = `ticket=${ticket}`;
  } catch (error) {
    target.hash = `auth_error=${error.status === 403 ? 'denied' : 'failed'}`;
  }
  return Response.redirect(target.href, 302);
}

async function redeemLogin(request, env) {
  const { ticket, verifier } = (await readJson(request)) || {};
  if (!/^[\w-]{43}$/.test(ticket || '') || !/^[\w-]{43}$/.test(verifier || '')) throw new HttpError(400, '로그인 확인 정보가 올바르지 않습니다.');
  const challenge = encode64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
  const saved = await env.DB.prepare('DELETE FROM login_tickets WHERE ticket = ? AND challenge = ? AND expires > ? RETURNING user_id, user_name').bind(ticket, challenge, now()).first();
  if (!saved || !allowed(env, saved.user_id)) throw new HttpError(401, '로그인을 다시 시작해 주세요.');
  const user = { id: saved.user_id, name: saved.user_name };
  return json({ user, session: await issueSession(env, user) });
}

async function googleToken(env) {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new HttpError(503, 'Drive 인증 설정이 필요합니다.');
  if (googleCache?.source === env.GOOGLE_SERVICE_ACCOUNT_JSON && googleCache.expiresAt > Date.now() + 60000) return googleCache;
  if (googleCache?.source === env.GOOGLE_SERVICE_ACCOUNT_JSON && googleCache.pending) return googleCache.pending;
  const state = { source: env.GOOGLE_SERVICE_ACCOUNT_JSON };
  googleCache = state;
  state.pending = (async () => {
    const account = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const header = encode64(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const payload = encode64(encoder.encode(JSON.stringify({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now(), exp: now() + 3600 })));
    const privateBytes = decode64(account.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''));
    const key = await crypto.subtle.importKey('pkcs8', privateBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const data = `${header}.${payload}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(data));
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${data}.${encode64(new Uint8Array(signature))}` }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'Drive 인증에 실패했습니다.'); }
    const result = await response.json();
    state.token = result.access_token;
    state.expiresAt = Date.now() + result.expires_in * 1000;
    return state;
  })();
  try { return await state.pending; }
  finally { state.pending = undefined; }
}

async function library(env, refresh = false) {
  if (!refresh && libraryCache?.folder === env.DRIVE_FOLDER_ID && libraryCache.expires > Date.now()) return libraryCache.files;
  if (libraryPending?.folder === env.DRIVE_FOLDER_ID) return libraryPending.promise;
  const state = { folder: env.DRIVE_FOLDER_ID };
  libraryPending = state;
  state.promise = (async () => {
    if (!/^[\w-]+$/.test(env.DRIVE_FOLDER_ID || '')) throw new HttpError(503, 'Drive 폴더 설정이 필요합니다.');
    const files = [];
    const token = await googleToken(env);
    const params = new URLSearchParams({ q: `'${env.DRIVE_FOLDER_ID}' in parents and trashed = false and mimeType = 'video/mp4'`, fields: 'nextPageToken,files(id,name,size,modifiedTime,capabilities(canDownload))', pageSize: '1000', orderBy: 'name_natural' });
    do {
      const response = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { authorization: `Bearer ${token.token}` }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'Drive 영상 목록을 가져오지 못했습니다.'); }
      const data = await response.json();
      for (const file of data.files || []) {
        const size = Number(file.size);
        if (file.capabilities?.canDownload && Number.isSafeInteger(size) && size > 0) files.push({ id: file.id, name: file.name, size, modifiedTime: file.modifiedTime });
      }
      if (!data.nextPageToken) break;
      params.set('pageToken', data.nextPageToken);
    } while (true);
    libraryCache = { folder: env.DRIVE_FOLDER_ID, files, expires: Date.now() + 30000 };
    return files;
  })();
  try { return await state.promise; }
  finally { if (libraryPending === state) libraryPending = undefined; }
}

function playlistInput(data) {
  const name = typeof data?.name === 'string' ? data.name.trim() : '';
  const items = data?.items;
  if (!name || name.length > 80 || !Array.isArray(items) || items.length > 500 || items.some(id => typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) || new Set(items).size !== items.length) throw new HttpError(400, '목록 이름과 항목을 확인해 주세요.');
  return { name, items };
}

async function interaction(request, env) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  if (!/^[\da-f]{128}$/i.test(signature || '') || !/^\d{1,12}$/.test(timestamp || '') || Math.abs(now() - Number(timestamp)) > 300) throw new HttpError(401, 'Discord 서명이 올바르지 않습니다.');
  if (Number(request.headers.get('content-length')) > 128 * 1024) throw new HttpError(413, '요청이 너무 큽니다.');
  const raw = await readBytes(request);
  const prefix = encoder.encode(timestamp);
  const message = new Uint8Array(prefix.length + raw.length);
  message.set(prefix); message.set(raw, prefix.length);
  const toBytes = hex => Uint8Array.from(hex.match(/../g), value => parseInt(value, 16));
  if (!/^[\da-f]{64}$/i.test(env.DISCORD_PUBLIC_KEY || '')) throw new HttpError(503, 'Discord 공개 키 설정이 필요합니다.');
  const key = await crypto.subtle.importKey('raw', toBytes(env.DISCORD_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, toBytes(signature), message)) throw new HttpError(401, 'Discord 서명이 올바르지 않습니다.');
  let event;
  try { event = JSON.parse(new TextDecoder().decode(raw)); }
  catch { throw new HttpError(400, '요청 형식이 올바르지 않습니다.'); }
  if (event.type === 1) return json({ type: 1 });
  if (event.type !== 2 || event.data?.name !== '시청') throw new HttpError(400, '지원하는 명령은 /시청입니다.');
  const userId = event.member?.user?.id || event.user?.id;
  if (!allowed(env, userId) || (env.DISCORD_GUILD_ID && env.DISCORD_GUILD_ID !== event.guild_id)) return json({ type: 4, data: { content: '이 계정 또는 서버에 시청 권한이 없습니다.', flags: 64 } });
  return json({ type: 12 });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.startsWith('/api/') ? url.pathname.slice(4) : url.pathname;
  const method = request.method;
  if (method === 'POST' && path === '/interactions') return interaction(request, env);
  if (method === 'GET' && path === '/config') return json({ clientId: env.DISCORD_CLIENT_ID || '' });
  if (method === 'GET' && path === '/auth/start') return authStart(url, env);
  if (method === 'GET' && path === '/auth/callback') return authCallback(url, env);
  if (method === 'POST' && path === '/auth/redeem') return redeemLogin(request, env);
  if (method === 'POST' && path === '/discord-login') {
    const data = await readJson(request);
    const login = await discordLogin(env, data?.code);
    return json({ accessToken: login.accessToken, user: login.user, session: await issueSession(env, login.user) });
  }
  const user = await requireUser(request, env);
  if (method === 'GET' && path === '/me') return json(user);
  if (method === 'GET' && path === '/library') return json(await library(env, url.searchParams.has('refresh')));
  const media = /^\/media-auth\/([\w-]{1,128})$/.exec(path);
  if (method === 'GET' && media) {
    const file = (await library(env)).find(file => file.id === media[1]);
    if (!file) throw new HttpError(404, '연결된 폴더에서 영상을 찾을 수 없습니다.');
    const token = await googleToken(env);
    return json({ token: token.token, expiresAt: token.expiresAt, file });
  }
  if (method === 'GET' && path === '/playlists') {
    const result = await env.DB.prepare('SELECT id, name, items FROM playlists WHERE owner = ? ORDER BY created, id').bind(user.id).all();
    return json(result.results.map(entry => ({ ...entry, items: JSON.parse(entry.items) })));
  }
  if (method === 'POST' && path === '/playlists') {
    const entry = { id: crypto.randomUUID(), ...playlistInput(await readJson(request)) };
    const result = await env.DB.prepare('INSERT INTO playlists (id, owner, name, items, created) SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM playlists WHERE owner = ?) < 100').bind(entry.id, user.id, entry.name, JSON.stringify(entry.items), Date.now(), user.id).run();
    if (!result.meta.changes) throw new HttpError(400, '재생목록은 100개까지 만들 수 있습니다.');
    return json(entry, 201);
  }
  const playlist = /^\/playlists\/([\da-f-]{36})$/.exec(path);
  if (method === 'PUT' && playlist) {
    const entry = { id: playlist[1], ...playlistInput(await readJson(request)) };
    const result = await env.DB.prepare('UPDATE playlists SET name = ?, items = ? WHERE id = ? AND owner = ?').bind(entry.name, JSON.stringify(entry.items), entry.id, user.id).run();
    if (!result.meta.changes) throw new HttpError(404, '재생목록을 찾을 수 없습니다.');
    return json(entry);
  }
  if (method === 'DELETE' && playlist) {
    const result = await env.DB.prepare('DELETE FROM playlists WHERE id = ? AND owner = ?').bind(playlist[1], user.id).run();
    if (!result.meta.changes) throw new HttpError(404, '재생목록을 찾을 수 없습니다.');
    return new Response(null, { status: 204 });
  }
  throw new HttpError(404, '요청한 경로를 찾을 수 없습니다.');
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin');
    const allowedOrigins = [`https://${env.DISCORD_CLIENT_ID}.discordsays.com`];
    if (env.FRONTEND_URL) allowedOrigins.push(new URL(env.FRONTEND_URL).origin);
    if (env.DEV_ORIGIN) allowedOrigins.push(env.DEV_ORIGIN);
    let response;
    try {
      if (origin && !allowedOrigins.includes(origin)) throw new HttpError(403, '허용된 플레이어 주소에서 요청해 주세요.');
      response = request.method === 'OPTIONS' ? new Response(null, { status: 204 }) : await route(request, env);
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('API request failed', error.name);
      response = json({ error: error.status ? error.message : 'API 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.' }, error.status || 502);
    }
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'private, no-store');
    headers.set('referrer-policy', 'no-referrer');
    headers.set('x-content-type-options', 'nosniff');
    if (origin && allowedOrigins.includes(origin)) {
      headers.set('access-control-allow-origin', origin);
      headers.set('vary', 'Origin');
      headers.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
      headers.set('access-control-allow-headers', 'Authorization, Content-Type');
    }
    return new Response(response.body, { status: response.status, headers });
  },
};
