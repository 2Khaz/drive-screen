export function playbackResume(value) {
  if (!value || typeof value !== 'object' || typeof value.fileId !== 'string' || !/^[\w-]{1,128}$/.test(value.fileId)) return null;
  if (!Number.isFinite(value.time) || value.time < 0 || value.time > 7 * 86400) return null;
  if (value.playlistId && (typeof value.playlistId !== 'string' || !/^[\da-f-]{36}$/i.test(value.playlistId))) return null;
  return {
    fileId: value.fileId, time: Math.floor(value.time), playlistId: value.playlistId || '',
    repeat: [0, 1, 2].includes(value.repeat) ? value.repeat : 0, shuffle: value.shuffle === true,
  };
}

export function parseResume(text) {
  if (typeof text !== 'string' || text.length > 1024) return null;
  try { return playbackResume(JSON.parse(text)); } catch { return null; }
}

export function playbackLink(base, value) {
  const url = new URL(base);
  const resume = playbackResume(value);
  // Only a file ID and playback settings cross the handoff. No names, Drive
  // credentials, Discord OAuth tokens, or app sessions are included.
  if (resume) url.hash = new URLSearchParams({ resume: JSON.stringify(resume) });
  return url.href;
}
