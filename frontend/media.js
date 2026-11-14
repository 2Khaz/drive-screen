import { createFile } from 'mp4box';
import { mediaAuth, driveUrl } from './transport.js';
import { RangeCache } from './range-cache.js';

const MiB = 1024 * 1024;
const chunkSize = 4 * MiB;
const abortError = () => new DOMException('재생 요청이 바뀌었습니다.', 'AbortError');
const wait = (signal, ms) => new Promise(resolve => {
  if (signal.aborted) { resolve(); return; }
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});
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
    const MediaSourceType = window.ManagedMediaSource || window.MediaSource;
    if (!MediaSourceType) throw new Error('이 재생 환경에는 영상 스트리밍 기능이 없습니다. Android는 최신 Chrome, iPhone은 iOS 17.1 이상 Safari에서 열어 주세요.');
    const state = { controller: new AbortController(), parser: createFile(true), source: new MediaSourceType(), tracks: [], cache: new RangeCache(), targetAhead: 30, offset: 0, ready: false, seek: null, generation: 0, auth: null };
    this.state = state;
    const { video } = this;
    const { signal } = state.controller;
    const authPromise = mediaAuth(id, { signal });
    // Observe failures while MediaSource opens; both preparations run together.
    authPromise.catch(() => {});
    // iPhone activates ManagedMediaSource only with an AirPlay alternative or
    // remote playback disabled. There is no anonymous AirPlay URL for Drive.
    if (window.ManagedMediaSource) video.disableRemotePlayback = true;
    state.objectUrl = URL.createObjectURL(state.source);
    video.src = state.objectUrl;
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); state.source.removeEventListener('sourceopen', opened); signal.removeEventListener('abort', aborted); };
      const opened = () => { cleanup(); resolve(); };
      const aborted = () => { cleanup(); reject(abortError()); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('재생기가 열리지 않았습니다. 브라우저에서 열어 다시 시도해 주세요.')); }, 15000);
      state.source.addEventListener('sourceopen', opened, { once: true });
      signal.addEventListener('abort', aborted, { once: true });
    });
    if (signal.aborted) throw abortError();
    const auth = await authPromise;
    if (signal.aborted) throw abortError();
    state.auth = auth;
    state.parser.onError = () => this.fail(state, new Error('MP4 정보를 읽지 못했습니다. 파일이 손상되었거나 지원하지 않는 형식입니다.'));
    state.parser.onReady = info => {
      try {
        const tracks = info.tracks.filter(track => track.video || track.audio);
        if (!tracks.some(track => track.video)) throw new Error('재생할 영상 트랙이 없습니다.');
        const bitrate = tracks.reduce((sum, track) => sum + (Number.isFinite(track.bitrate) ? track.bitrate : 0), 0);
        state.targetAhead = bitrate > 0 ? Math.max(4, Math.min(60, 24 * MiB * 8 / bitrate)) : 30;
        for (const track of tracks) {
          const mime = `${track.video ? 'video' : 'audio'}/mp4; codecs="${track.codec}"`;
          if (!MediaSourceType.isTypeSupported(mime)) throw new Error('지원하지 않는 영상 또는 오디오 코덱입니다. H.264/AAC MP4를 사용해 주세요.');
          const entry = { id: track.id, buffer: state.source.addSourceBuffer(mime), pending: Promise.resolve() };
          state.tracks.push(entry);
          // MP4Box requires the same sample count for every segmented track.
          // Start with short fragments; seeking itself is still aligned to a
          // keyframe. Waiting for the next keyframe can otherwise add seconds.
          state.parser.setSegmentOptions(track.id, entry, { nbSamples: 12, rapAlignement: false });
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

  async read(state, id, offset, consume) {
    const cached = state.cache.get(offset);
    if (cached) { await consume(cached); return; }
    if (state.auth.expiresAt < Date.now() + 60000) state.auth = await mediaAuth(id, { signal: state.controller.signal });
    for (let attempt = 0; attempt < 2; attempt++) {
      state.fetchController = new AbortController();
      const fetchController = state.fetchController;
      const abort = () => fetchController.abort();
      state.controller.signal.addEventListener('abort', abort, { once: true });
      if (state.controller.signal.aborted) abort();
      const timeout = () => fetchController.abort(new DOMException('Drive 요청 시간 초과', 'TimeoutError'));
      let timer = setTimeout(timeout, 30000);
      try {
        const size = !state.ready && offset === 0 ? 256 * 1024 : chunkSize;
        const end = Math.min(state.auth.file.size - 1, offset + size - 1);
        let response;
        try { response = await fetch(driveUrl(id), { headers: { authorization: `Bearer ${state.auth.token}`, range: `bytes=${offset}-${end}` }, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: fetchController.signal }); }
        catch (error) { error.retryable = true; throw error; }
        if (response.status === 401 && attempt === 0) { await response.body?.cancel(); state.auth = await mediaAuth(id, { force: true, signal: state.controller.signal }); continue; }
        if (response.status !== 206) {
          await response.body?.cancel();
          const error = new Error(`Drive에서 영상 일부를 읽지 못했습니다 (${response.status}). 잠시 후 다시 시도해 주세요.`);
          error.retryable = response.status === 429 || response.status >= 500;
          throw error;
        }
        if (!response.body) throw new Error('Drive에서 받은 영상 데이터가 비어 있습니다.');
        const reader = response.body.getReader();
        let position = offset;
        let ended = false;
        try {
          while (true) {
            let part;
            try { part = await reader.read(); } catch (error) { error.retryable = true; throw error; }
            const { done, value } = part;
            if (done) { ended = true; break; }
            clearTimeout(timer); timer = setTimeout(timeout, 30000);
            if (position + value.byteLength > end + 1) throw new Error('Drive에서 받은 영상 조각의 크기가 올바르지 않습니다.');
            const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            buffer.fileStart = position;
            state.cache.put(position, buffer);
            position += buffer.byteLength;
            // The parser can ask to skip straight to a tail moov box, or back
            // to media data after reading it. Cancel the unused response tail.
            if (!await consume(buffer)) return;
          }
          if (position !== end + 1) throw new Error('Drive에서 받은 영상 조각의 크기가 올바르지 않습니다.');
          return;
        } finally { if (!ended) await reader.cancel().catch(() => {}); }
      } finally { clearTimeout(timer); state.controller.signal.removeEventListener('abort', abort); }
    }
  }

  async pump(state, id) {
    let metadataBytes = 0;
    let eof = false;
    let retries = 0;
    while (!state.controller.signal.aborted) {
      await Promise.all(state.tracks.map(track => track.pending));
      if (state.controller.signal.aborted) return;
      if (state.seek !== null) {
        const time = state.seek;
        state.seek = null;
        retries = 0;
        state.generation++;
        state.parser.stop();
        state.offset = state.parser.seek(time, true).offset;
        state.parser.start();
        eof = false;
        // Cached samples may be emitted synchronously by start(). Their MSE
        // appends must finish before evicting old SourceBuffer ranges.
        await Promise.all(state.tracks.map(track => track.pending));
        if (state.controller.signal.aborted) return;
      }
      // A small MP4 may already be entirely consumed while reading its moov.
      // Finish it without issuing an invalid Range starting at the file size.
      if (state.ready && !eof && state.offset >= state.auth.file.size) {
        state.parser.flush();
        eof = true;
        continue;
      }
      for (const track of state.tracks) {
        const before = this.video.currentTime - 10;
        if (before > 0 && track.buffer.buffered.length && track.buffer.buffered.start(0) < before) await this.update(state, track.buffer, () => track.buffer.remove(0, before));
        const after = this.video.currentTime + 90;
        if (track.buffer.buffered.length && track.buffer.buffered.end(track.buffer.buffered.length - 1) > after) await this.update(state, track.buffer, () => track.buffer.remove(after, Infinity));
      }
      const ahead = bufferedAt(this.video.buffered, this.video.currentTime) - this.video.currentTime;
      const managedEnough = state.source.streaming === false && ahead > Math.min(8, state.targetAhead);
      if (state.ready && (eof || ahead > state.targetAhead || managedEnough)) {
        if (eof && state.source.readyState === 'open') state.source.endOfStream();
        await wait(state.controller.signal, 250);
        continue;
      }
      const offset = state.offset;
      try { await this.read(state, id, offset, async buffer => {
        if (state.controller.signal.aborted || state.seek !== null) return false;
        const wasReady = state.ready;
        const next = state.parser.appendBuffer(buffer);
        const end = buffer.fileStart + buffer.byteLength;
        if (!state.ready) {
          metadataBytes += buffer.byteLength;
          if (metadataBytes > 32 * MiB) throw new Error('MP4의 색인 정보가 너무 큽니다. 스트리밍에 맞게 변환한 파일을 사용해 주세요.');
        }
        state.offset = !wasReady && state.ready && Number.isSafeInteger(next) && next >= 0
          ? next : Number.isSafeInteger(next) && next > end ? next : end;
        await Promise.all(state.tracks.map(track => track.pending));
        return !state.controller.signal.aborted && state.seek === null && state.offset === end;
      }); retries = 0; }
      catch (error) {
        if (state.controller.signal.aborted) return;
        if (error.name === 'AbortError' && state.seek !== null) continue;
        const buffered = bufferedAt(this.video.buffered, this.video.currentTime) - this.video.currentTime;
        if (error.retryable && (retries < 4 || (!this.video.paused && buffered > 2))) {
          retries = Math.min(retries + 1, 5);
          await wait(state.controller.signal, Math.min(5000, 250 * 2 ** retries));
          continue;
        }
        if (error.name === 'AbortError') throw new Error('영상 연결이 중단됐습니다. 연결 상태를 확인한 뒤 영상을 다시 선택해 주세요.');
        throw error;
      }
      if (state.seek !== null) continue;
      if (state.offset >= state.auth.file.size) {
        if (!state.ready) throw new Error('MP4 재생 정보를 찾지 못했습니다.');
        state.parser.flush();
        eof = true;
      }
    }
  }
}
