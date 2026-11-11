import { DiscordSDK } from '@discord/embedded-app-sdk';

const storageKey = 'drive-screen-session';
let config;
let session = sessionStorage.getItem(storageKey) || '';
const embedded = window.parent !== window;

export async function api(path, { method = 'GET', data } = {}) {
  const base = embedded ? `${location.origin}/api` : config.apiBase.replace(/\/$/, '') + '/api';
  const response = await fetch(`${base}/${path}`, {
    method, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: { ...(session ? { authorization: `Bearer ${session}` } : {}), ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (response.status === 204) return;
  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 401) { session = ''; sessionStorage.removeItem(storageKey); document.getElementById('login').hidden = embedded; }
    throw new Error(payload.error || `요청이 실패했습니다 (${response.status}).`);
  }
  return payload;
}

function saveSession(value) { session = value; sessionStorage.setItem(storageKey, value); }
function base64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

export async function startLogin() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem('drive-screen-verifier', verifier);
  location.assign(`${config.apiBase.replace(/\/$/, '')}/auth/start?challenge=${challenge}`);
}

export async function connect() {
  const response = await fetch(new URL('./config.json', location.href), { cache: 'no-store' });
  if (!response.ok) throw new Error('플레이어 설정을 가져오지 못했습니다.');
  config = await response.json();
  if (!config.apiBase || !config.discordClientId) return 'pending';
  if (embedded) {
    const sdk = new DiscordSDK(config.discordClientId);
    await sdk.ready();
    const { code } = await sdk.commands.authorize({ client_id: config.discordClientId, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] });
    const login = await api('discord-login', { method: 'POST', data: { code } });
    saveSession(login.session);
    if (!await sdk.commands.authenticate({ access_token: login.accessToken })) throw new Error('Discord 인증을 완료하지 못했습니다.');
  } else {
    document.getElementById('login').hidden = false;
    const fragment = new URLSearchParams(location.hash.slice(1));
    const ticket = fragment.get('ticket');
    const authError = fragment.get('auth_error');
    if (ticket || authError) history.replaceState(null, '', location.pathname + location.search);
    if (authError) throw new Error(authError === 'denied' ? '이 Discord 계정에는 시청 권한이 없습니다.' : '로그인을 완료하지 못했습니다. 다시 시도해 주세요.');
    if (ticket) {
      const verifier = sessionStorage.getItem('drive-screen-verifier');
      sessionStorage.removeItem('drive-screen-verifier');
      const login = await api('auth/redeem', { method: 'POST', data: { ticket, verifier } });
      saveSession(login.session);
    }
    if (!session) { document.getElementById('login').hidden = false; return false; }
  }
  return true;
}

export function driveUrl(id) {
  const base = embedded ? `${location.origin}/gdrive` : 'https://www.googleapis.com';
  return `${base}/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
}
