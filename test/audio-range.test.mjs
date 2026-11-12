import test from 'node:test';
import assert from 'node:assert/strict';
import { audioRange } from '../frontend/audio-range.js';
test('native audio byte ranges including Safari probes and suffixes', () => {
  assert.deepEqual(audioRange('bytes=0-1', 100), { start: 0, end: 1, partial: true });
  assert.deepEqual(audioRange('bytes=50-', 100), { start: 50, end: 99, partial: true });
  assert.deepEqual(audioRange('bytes=-20', 100), { start: 80, end: 99, partial: true });
  assert.deepEqual(audioRange('bytes=0-999', 100), { start: 0, end: 99, partial: true });
  assert.deepEqual(audioRange(null, 100), { start: 0, end: 99, partial: false });
  for (const value of ['bytes=100-', 'bytes=-0', 'bytes=9-2', 'bytes=-', 'bytes=0-1,2-3', 'bad']) assert.equal(audioRange(value, 100), null);
  assert.equal(audioRange(null, 0), null);
});
