import { createFile } from 'mp4box';
import { api, driveUrl } from './transport.js';

const chunkSize = 1024 * 1024;
const abortError = () => new DOMException('재생 요청이 바뀌었습니다.', 'AbortError');
const bufferedAt = (ranges, time) => {
  for (let i = 0; i < ranges.length; i++) if (ranges.start(i) <= time + 0.15 && ranges.end(i) > time) return ranges.end(i);
  return time;
};

// MP4 is remuxed into MSE fragments. Credentials stay in headers, and only
// a bounded window of video bytes is retained by the browser.
export class DrivePlayer {
  constructor(video, onError) { this.video = video; this.onError = onError; }

  close() {
    if (!this.state) return;
    this.state.controller.abort();
    this.state.fetchController?.abort();
    this.state.parser.stop();
    this.video.removeEventListener('seeking', this.state.seekHandler);
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.state.objectUrl);
    this.state = null;
  }

  async load(id) {
    this.close();
    if (!window.MediaSource) throw new Error('이 브라우저에서는 Drive 직접 재생을 지원하지 않습니다. PC Chrome 또는 Edge에서 열어 주세요.');
    const state = { controller: new AbortController(), parser: createFile(true), source: new MediaSource(), tracks: [], offset: 0, ready: false, seek: null, generation: 0, auth: null };
    this.state = state;
    const { video } = this;
    const { signal } = state.controller;
    state.objectUrl = URL.createObjectURL(state.source);
    video.src = state.objectUrl;
    await new Promise((resolve, reject) => {
      state.source.addEventListener('sourceopen', resolve, { once: true, signal });
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    if (signal.aborted) throw abortError();
    const auth = await api(`media-auth/${id}`);
    if (signal.aborted) throw abortError();
    state.auth = auth;
    state.parser.onError = () => this.fail(state, new Error('MP4 정보를 읽지 못했습니다. 파일이 손상되었거나 지원하지 않는 형식입니다.'));
    state.parser.onReady = info => {
      try {
        const tracks = info.tracks.filter(track => track.video || track.audio);
        if (!tracks.some(track => track.video)) throw new Error('재생할 영상 트랙이 없습니다.');
        for (const track of tracks) {
          const mime = `${track.video ? 'video' : 'audio'}/mp4; codecs="${track.codec}"`;
          if (!MediaSource.isTypeSupported(mime)) throw new Error('지원하지 않는 영상 또는 오디오 코덱입니다. H.264/AAC MP4를 사용해 주세요.');
          const entry = { id: track.id, buffer: state.source.addSourceBuffer(mime), pending: Promise.resolve() };
          state.tracks.push(entry);
          // MP4Box requires the same sample count for every segmented track.
          state.parser.setSegmentOptions(track.id, entry, { nbSamples: 48, rapAlignement: true });
        }
        state.source.duration = info.duration / info.timescale;
        for (const init of state.parser.initializeSegmentation('per-track')) this.append(state, init.user, init.buffer);
        state.offset = state.parser.seek(0, true).offset;
        state.ready = true;
        state.parser.start();
      } catch (error) { this.fail(state, error); }
    };
    state.parser.onSegment = (trackId, track, buffer, nextSample) => {
      this.append(state, track, buffer, () => state.parser.releaseUsedSamples(trackId, nextSample));
    };
    state.seekHandler = () => {
      if (!state.ready || bufferedAt(video.buffered, video.currentTime) > video.currentTime + 0.2) return;
      state.seek = video.currentTime;
      state.fetchController?.abort();
    };
    video.addEventListener('seeking', state.seekHandler);
    this.pump(state, id).catch(error => { if (error.name !== 'AbortError') this.fail(state, error); });
  }

  fail(state, error) {
    if (this.state !== state || state.controller.signal.aborted) return;
    state.controller.abort();
    state.fetchController?.abort();
    this.video.pause();
    this.onError(error);
  }

  append(state, track, bytes, release) {
    const generation = state.generation;
    track.pending = track.pending.then(async () => {
      if (state.controller.signal.aborted || generation !== state.generation) return;
      await this.update(state, track.buffer, () => track.buffer.appendBuffer(bytes));
      release?.();
    }).catch(error => { if (error.name !== 'AbortError') this.fail(state, error); });
  }

  async update(state, buffer, action) {
    if (state.controller.signal.aborted) throw abortError();
    await new Promise((resolve, reject) => {
      const signal = state.controller.signal;
      const done = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('영상 조각을 재생기에 넣지 못했습니다.')); };
      const aborted = () => { cleanup(); reject(abortError()); };
      const cleanup = () => { buffer.removeEventListener('updateend', done); buffer.removeEventListener('error', failed); signal.removeEventListener('abort', aborted); };
      buffer.addEventListener('updateend', done, { once: true });
      buffer.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', aborted, { once: true });
      try { action(); } catch (error) { cleanup(); reject(error); }
    });
  }

  async read(state, id, offset) {
    if (state.auth.expiresAt < Date.now() + 60000) state.auth = await api(`media-auth/${id}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      state.fetchController = new AbortController();
      const signal = AbortSignal.any([state.controller.signal, state.fetchController.signal, AbortSignal.timeout(30000)]);
      const end = Math.min(state.auth.file.size - 1, offset + chunkSize - 1);
      const response = await fetch(driveUrl(id), { headers: { authorization: `Bearer ${state.auth.token}`, range: `bytes=${offset}-${end}` }, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal });
      if (response.status === 401 && attempt === 0) { await response.body?.cancel(); state.auth = await api(`media-auth/${id}`); continue; }
      if (response.status !== 206) { await response.body?.cancel(); throw new Error(`Drive에서 영상 일부를 읽지 못했습니다 (${response.status}). 잠시 후 다시 시도해 주세요.`); }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== end - offset + 1) throw new Error('Drive에서 받은 영상 조각의 크기가 올바르지 않습니다.');
      buffer.fileStart = offset;
      return buffer;
    }
  }

  async pump(state, id) {
    let metadataBytes = 0;
    let eof = false;
    while (!state.controller.signal.aborted) {
      await Promise.all(state.tracks.map(track => track.pending));
      if (state.controller.signal.aborted) return;
      if (state.seek !== null) {
        const time = state.seek;
        state.seek = null;
        state.generation++;
        state.parser.stop();
        state.offset = state.parser.seek(time, true).offset;
        state.parser.start();
        eof = false;
      }
      for (const track of state.tracks) {
        const before = this.video.currentTime - 30;
        if (before > 0 && track.buffer.buffered.length && track.buffer.buffered.start(0) < before) await this.update(state, track.buffer, () => track.buffer.remove(0, before));
        const after = this.video.currentTime + 90;
        if (track.buffer.buffered.length && track.buffer.buffered.end(track.buffer.buffered.length - 1) > after) await this.update(state, track.buffer, () => track.buffer.remove(after, Infinity));
      }
      if (state.ready && (eof || bufferedAt(this.video.buffered, this.video.currentTime) - this.video.currentTime > 30)) {
        if (eof && state.source.readyState === 'open') state.source.endOfStream();
        await new Promise(resolve => {
          const signal = state.controller.signal;
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 250);
          signal.addEventListener('abort', done, { once: true });
        });
        continue;
      }
      const wasReady = state.ready;
      const offset = state.offset;
      let buffer;
      try { buffer = await this.read(state, id, offset); }
      catch (error) { if (error.name === 'AbortError' && state.seek !== null && !state.controller.signal.aborted) continue; throw error; }
      if (state.seek !== null) continue;
      const next = state.parser.appendBuffer(buffer);
      if (!state.ready) {
        metadataBytes += buffer.byteLength;
        if (metadataBytes > 32 * chunkSize) throw new Error('MP4의 색인 정보가 너무 큽니다. 스트리밍에 맞게 변환한 파일을 사용해 주세요.');
      }
      if (!wasReady && state.ready) continue;
      state.offset = Number.isSafeInteger(next) && next > offset ? next : offset + buffer.byteLength;
      if (state.offset >= state.auth.file.size) {
        if (!state.ready) throw new Error('MP4 재생 정보를 찾지 못했습니다.');
        state.parser.flush();
        eof = true;
      }
    }
  }
}
