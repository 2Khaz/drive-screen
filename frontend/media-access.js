// Only the currently authenticated page keeps these short-lived credentials.
// Nothing is written to storage, URLs, or another tab.
export class MediaAccess {
  constructor(request) { this.request = request; this.clear(); }
  clear() { this.files = new Map(); this.access = null; this.version = (this.version || 0) + 1; }
  setFiles(files) { this.files = new Map(files.map(file => [file.id, file])); }
  seed(files, access) { this.setFiles(files); this.access = access; }
  async get(id, { force = false, signal } = {}) {
    signal?.throwIfAborted();
    const file = this.files.get(id);
    if (!force && file && this.access?.expiresAt > Date.now() + 60000) return { ...this.access, file };
    const version = this.version;
    const value = await this.request(id, signal);
    signal?.throwIfAborted();
    if (version !== this.version) throw new DOMException('로그인 정보가 변경됐습니다.', 'AbortError');
    if (value.file?.id !== id) throw new Error('재생 인증의 파일 정보가 일치하지 않습니다.');
    this.files.set(id, value.file);
    this.access = { token: value.token, expiresAt: value.expiresAt };
    return value;
  }
}
