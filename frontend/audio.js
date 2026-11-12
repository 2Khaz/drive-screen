import { api } from './transport.js';

const providers = new Map();
let registrationPromise;
const workerUrl = new URL('./audio-sw.js', location.href);

if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', async event => {
  if (event.source !== navigator.serviceWorker.controller || event.data?.type !== 'drive-audio-auth' || !event.ports[0]) return;
  const provider = providers.get(event.data.fileId);
  try {
    if (!provider) throw new Error('inactive media');
    const value = await provider(event.data.refresh === true);
    event.ports[0].postMessage({ token: value.token, expiresAt: value.expiresAt, size: value.file.size });
  } catch { event.ports[0].postMessage({ error: 'not authorized' }); }
});

async function workerRegistration() {
  if (!('serviceWorker' in navigator)) throw new Error('이 앱 안에서는 MP3 스트리밍을 사용할 수 없습니다. 브라우저로 이어재생을 눌러 Chrome 또는 Safari에서 열어 주세요.');
  if (!registrationPromise) registrationPromise = (async () => {
    const registration = await navigator.serviceWorker.register(workerUrl, { scope: new URL('./', location.href).pathname, updateViaCache: 'none' });
    await new Promise((resolve, reject) => {
      const matching = () => navigator.serviceWorker.controller?.scriptURL === workerUrl.href;
      if (matching()) { resolve(); return; }
      const changed = () => { if (matching()) { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(new Error('오디오 연결이 준비되지 않았습니다. 페이지를 새로고침하거나 외부 브라우저로 열어 주세요.')); }, 12000);
      const cleanup = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', changed); };
      navigator.serviceWorker.addEventListener('controllerchange', changed);
    });
    return registration;
  })().catch(() => { registrationPromise = undefined; throw new Error('이 앱 안에서는 MP3 스트리밍을 사용할 수 없습니다. 브라우저로 이어재생을 눌러 Chrome 또는 Safari에서 열어 주세요.'); });
  return registrationPromise;
}

export class AudioPlayer {
  constructor(audio) { this.audio = audio; }
  close() {
    if (!this.state) return;
    const { id, controller } = this.state;
    controller.abort(); providers.delete(id);
    this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); this.state = null;
  }
  async load(id) {
    this.close();
    const state = { id, controller: new AbortController(), auth: null };
    this.state = state;
    const authorize = async force => {
      if (state.controller.signal.aborted) throw new DOMException('재생이 변경됐습니다.', 'AbortError');
      if (force || !state.auth || state.auth.expiresAt < Date.now() + 60000) state.auth = await api(`media-auth/${id}`, { signal: state.controller.signal });
      return state.auth;
    };
    await authorize(false);
    const registration = await workerRegistration();
    if (state.controller.signal.aborted) throw new DOMException('재생이 변경됐습니다.', 'AbortError');
    providers.set(id, authorize);
    this.audio.src = new URL(`__audio/${encodeURIComponent(id)}.mp3`, registration.scope).href;
    this.audio.load();
  }
}
