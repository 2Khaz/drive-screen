// Per-video, memory-only byte cache. It never contains URLs or credentials.
export class RangeCache {
  constructor(limit = 16 * 1024 * 1024) { this.limit = limit; this.bytes = 0; this.entries = new Map(); }
  put(offset, buffer) {
    if (!buffer.byteLength || buffer.byteLength > this.limit) return;
    const previous = this.entries.get(offset);
    if (previous) { this.bytes -= previous.byteLength; this.entries.delete(offset); }
    const bytes = new Uint8Array(buffer).slice();
    this.entries.set(offset, bytes);
    this.bytes += bytes.byteLength;
    while (this.bytes > this.limit || this.entries.size > 1024) {
      const first = this.entries.keys().next().value;
      this.bytes -= this.entries.get(first).byteLength;
      this.entries.delete(first);
    }
  }
  get(offset) {
    for (const [start, bytes] of this.entries) {
      if (offset < start || offset >= start + bytes.byteLength) continue;
      this.entries.delete(start); this.entries.set(start, bytes);
      const buffer = bytes.slice(offset - start).buffer;
      buffer.fileStart = offset;
      return buffer;
    }
    return null;
  }
}
