import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResume, playbackLink } from '../frontend/handoff.js';

test('browser handoff keeps playback context and drops credentials and names', () => {
  const value = { fileId: 'sample-file', time: 95.9, playlistId: '12345678-1234-1234-1234-123456789012', repeat: 2, shuffle: true, token: 'private-token', session: 'private-session', name: 'private-name' };
  const url = new URL(playbackLink('https://example.github.io/drive-screen/', value));
  assert.equal(url.search, '');
  assert.ok(!url.href.includes('private-'));
  assert.deepEqual(parseResume(new URLSearchParams(url.hash.slice(1)).get('resume')), { fileId: 'sample-file', time: 95, playlistId: value.playlistId, repeat: 2, shuffle: true });
});

test('invalid or excessive resume data is rejected before playback', () => {
  for (const value of [null, 'not JSON', 'x'.repeat(1025), JSON.stringify({fileId:'../file',time:1}), JSON.stringify({fileId:'sample',time:-1}), JSON.stringify({fileId:'sample',time:Infinity}), JSON.stringify({fileId:'sample',time:1,playlistId:'bad'})]) assert.equal(parseResume(value), null);
  assert.equal(new URL(playbackLink('https://example.github.io/', null)).hash, '');
});
