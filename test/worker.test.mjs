import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../worker/index.mjs';

const encode = value => Buffer.from(value).toString('base64url');
const secret = 'sample-session-secret-used-only-in-unit-tests';
async function session(id = 'owner', expiry = Math.floor(Date.now() / 1000) + 3600) {
  const data = `${encode(JSON.stringify({ alg: 'HS256' }))}.${encode(JSON.stringify({ aud: 'drive-screen', sub: id, name: id, exp: expiry }))}`;
  const key = await crypto.subtle.importKey('raw', Buffer.from(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${data}.${encode(await crypto.subtle.sign('HMAC', key, Buffer.from(data)))}`;
}
function database() {
  const sqlite = new DatabaseSync(':memory:');
  function prepare(sql) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      async run() { return { meta: sqlite.prepare(sql).run(...values) }; },
    };
  }
  return { sqlite, prepare, async batch(statements) { sqlite.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
}

test('owner auth, isolation, OAuth replay, signed commands, and direct-media authorization', async () => {
  const DB = database();
  DB.sqlite.exec(await readFile(new URL('../worker/migrations/0001_initial.sql', import.meta.url), 'utf8'));
  const env = { DB, SESSION_SECRET: secret, DISCORD_ALLOWED_USERS: 'owner,second', DISCORD_CLIENT_ID: 'sample', DISCORD_CLIENT_SECRET: 'test-only', DISCORD_GUILD_ID: 'guild', FRONTEND_URL: 'https://example.github.io/drive-screen/', PUBLIC_API_URL: 'https://api.example.workers.dev', DRIVE_FOLDER_ID: 'test-folder' };
  const owner = await session();
  const second = await session('second');
  const request = (path, { token = owner, origin, method = 'GET', data, headers = {}, body } = {}) => worker.fetch(new Request(`https://api.example.workers.dev${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}), ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), ...(body === undefined ? {} : { body }),
  }), env);
  const originalFetch = globalThis.fetch;
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'sample@example.test', private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const outbound = [];
  globalThis.fetch = async (input, options) => {
    const url = String(input); outbound.push(url);
    if (url.endsWith('/oauth2/token') && url.includes('discord')) return Response.json({ access_token: 'sample-discord-token' });
    if (url.endsWith('/users/@me')) return Response.json({ id: 'owner', username: 'owner' });
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'sample-drive-token', expires_in: 3600 });
    if (url.startsWith('https://www.googleapis.com/drive/v3/files?')) { assert.equal(options.headers.authorization, 'Bearer sample-drive-token'); return Response.json({ files: [{ id: 'file-one', name: 'Sample.mp4', size: '1024', capabilities: { canDownload: true } }] }); }
    throw new Error('Unexpected outbound request');
  };
  try {
    assert.equal((await request('/api/library', { token: null })).status, 401);
    assert.equal((await request('/api/me', { token: owner + 'tampered' })).status, 401);
    assert.equal((await request('/api/me', { token: await session('outsider') })).status, 401);
    assert.equal((await request('/api/me', { token: await session('owner', 1) })).status, 401);
    assert.equal((await request('/api/me', { origin: 'https://evil.example' })).status, 403);
    const me = await request('/api/me', { origin: 'https://example.github.io' });
    assert.equal(me.headers.get('access-control-allow-origin'), 'https://example.github.io');
    assert.equal(me.headers.get('cache-control'), 'private, no-store');
    const created = await request('/api/playlists', { method: 'POST', data: { name: 'Sample', items: ['file-one'] } });
    assert.equal(created.status, 201); const entry = await created.json();
    assert.deepEqual(await (await request('/api/playlists', { token: second })).json(), []);
    assert.equal((await request(`/api/playlists/${entry.id}`, { token: second, method: 'DELETE' })).status, 404);
    assert.equal((await request(`/api/playlists/${entry.id}`, { token: second, method: 'PUT', data: { name: 'bad', items: [] } })).status, 404);
    assert.equal((await request('/api/playlists', { method: 'POST', data: { name: 'bad', items: ['duplicate', 'duplicate'] } })).status, 400);
    assert.equal((await request('/api/playlists', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(130 * 1024) })).status, 413);
    assert.equal((await request(`/api/playlists/${entry.id}`, { method: 'PUT', data: { name: 'Renamed', items: [] } })).status, 200);
    assert.equal((await request(`/api/playlists/${entry.id}`, { method: 'DELETE' })).status, 204);
    const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = encode(await crypto.subtle.digest('SHA-256', Buffer.from(verifier)));
    const start = await request(`/auth/start?challenge=${challenge}`, { token: null });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await request(`/auth/callback?state=${state}&code=sample`, { token: null });
    const ticket = new URLSearchParams(new URL(callback.headers.get('location')).hash.slice(1)).get('ticket');
    assert.ok(ticket);
    assert.equal((await request(`/auth/callback?state=${state}&code=sample`, { token: null })).status, 400);
    assert.equal((await request('/api/auth/redeem', { token: null, method: 'POST', data: { ticket, verifier: encode(crypto.getRandomValues(new Uint8Array(32))) } })).status, 401);
    assert.equal((await request('/api/auth/redeem', { token: null, method: 'POST', data: { ticket, verifier } })).status, 200);
    assert.equal((await request('/api/auth/redeem', { token: null, method: 'POST', data: { ticket, verifier } })).status, 401);
    assert.equal((await request('/api/media-auth/not-shared')).status, 404);
    const media = await (await request('/api/media-auth/file-one')).json();
    assert.equal(media.token, 'sample-drive-token');
    assert.equal(media.file.size, 1024);
    assert.ok(outbound.every(url => !url.includes('alt=media') && !url.includes('access_token=')));
    assert.equal((await request('/media/file-one')).status, 404);
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    env.DISCORD_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex');
    async function signed(event, timestamp = String(Math.floor(Date.now() / 1000))) {
      const body = JSON.stringify(event);
      const signature = Buffer.from(await crypto.subtle.sign('Ed25519', pair.privateKey, Buffer.from(timestamp + body))).toString('hex');
      return request('/interactions', { token: null, method: 'POST', body, headers: { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp } });
    }
    assert.deepEqual(await (await signed({ type: 1 })).json(), { type: 1 });
    assert.equal((await signed({ type: 1 }, '1')).status, 401);
    const command = { type: 2, data: { name: '시청' }, guild_id: 'guild', member: { user: { id: 'owner' } } };
    assert.deepEqual(await (await signed(command)).json(), { type: 12 });
    assert.equal((await (await signed({ ...command, guild_id: 'other' })).json()).data.flags, 64);
    assert.equal((await request('/interactions', { token: null, method: 'POST', data: { type: 1 } })).status, 401);
  } finally { globalThis.fetch = originalFetch; DB.sqlite.close(); }
});
