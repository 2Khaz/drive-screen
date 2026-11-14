import { nextQueue, reorderQueue, startQueue } from './queue.js';
import { api, bootstrap, mediaAuth, setMediaFiles, connect, startLogin, openInBrowser, isDiscordActivity, takePlaybackResume, capturePlaybackResume } from './transport.js';
import { AudioPlayer } from './audio.js';
import { CoverPip } from './cover-pip.js';
import { CoverImages } from './covers.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const audio = $('audio');
const listPicker = $('list-picker');
const dialog = $('list-dialog');
const pipButton = $('pip');
const standardPip = Boolean(document.pictureInPictureEnabled && video.requestPictureInPicture);
const pipSupported = () => standardPip || Boolean(video.webkitSupportsPresentationMode?.('picture-in-picture'));
const pipActive = () => document.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture';
const repeatModes = ['끔', '한 편', '전체'];
let library = [];
let playlists = [];
let filesById = new Map();
let selectedId = '';
let queue = null;
let queueName = '';
let shuffle = false;
let repeat = 0;
let saving = false;
let refreshing = false;
let dialogAction;
let changingPip = false;
let openingBrowser = false;


function notice(message = '', error = false) {
  const element = $('notice');
  element.hidden = !message;
  element.textContent = message;
  element.classList.toggle('error', error);
}

function explain(error) { notice(error.message, true); }
let videoPlayer;
let videoModule;
const prepareVideo = () => videoModule ||= import('./media.js').catch(error => { videoModule = null; throw error; });
const audioPlayer = new AudioPlayer(audio);
const coverPip = new CoverPip(video, $('audio-art'));
const covers = new CoverImages($('audio-art'), updateMetadata);
let audioMode = false;
const activeMedia = () => audioMode ? audio : video;
const player = {
  async load(id) {
    const file = filesById.get(id);
    const nextAudio = file?.kind === 'audio';
    audioPlayer.close();
    if (!nextAudio || !audioMode) { coverPip.stop(); videoPlayer?.close(); }
    audioMode = nextAudio;
    audio.hidden = $('audio-art').hidden = $('cover-actions').hidden = !nextAudio;
    if (nextAudio) {
      covers.load(file).catch(error => { if (currentFile() === id && error.status !== 404) explain(error); });
      coverPip.start();
      await audioPlayer.load(id);
    } else {
      const version = loadVersion;
      const [module] = await Promise.all([prepareVideo(), mediaAuth(id)]);
      if (version !== loadVersion) throw new DOMException('재생 요청이 바뀌었습니다.', 'AbortError');
      videoPlayer ||= new module.DrivePlayer(video, explain);
      await videoPlayer.load(id);
    }
  },
  close() { ++loadVersion; audioPlayer.close(); coverPip.stop(); videoPlayer?.close(); },
};
let loadVersion = 0;

function updateMetadata() {
  if (!('mediaSession' in navigator) || !('MediaMetadata' in window)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: $('now-playing').textContent, artist: 'Drive Screen', album: queueName,
    ...(audioMode ? { artwork: [{ src: $('audio-art').src }] } : {}),
  });
}

function selectedList() { return playlists.find(({ id }) => id === selectedId); }
function currentFile() { return queue?.order[queue.index]; }
function playable(items) { return items.filter((id) => filesById.has(id)); }

function setMediaAction(action, handler) {
  try { navigator.mediaSession.setActionHandler(action, handler); }
  catch (error) { if (error.name !== 'NotSupportedError') throw error; }
}

function makeButton(text, label, className, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', handler);
  return button;
}

function renderLists() {
  const list = selectedList();
  const options = [new Option('목록을 선택해 주세요', ''), ...playlists.map(({ id, name }) => new Option(name, id))];
  listPicker.replaceChildren(...options);
  listPicker.value = selectedId;
  listPicker.disabled = saving || !playlists.length;
  $('new-list').disabled = saving;
  $('play-list').disabled = !list || !playable(list.items).length;
  $('rename-list').disabled = !list || saving;
  $('delete-list').disabled = !list || saving;
  $('list-empty').hidden = Boolean(list?.items.length);
  $('list-empty').textContent = list ? '아래 보관함에서 ＋를 눌러 파일을 담으세요.' : '새 목록을 만들면 원하는 파일만 모아둘 수 있습니다.';
  const rows = (list?.items || []).map((id, index) => {
    const file = filesById.get(id);
    const title = file?.name ?? '폴더에서 찾을 수 없는 영상';
    const row = document.createElement('li');
    row.classList.toggle('current', id === currentFile());
    const play = makeButton(title, `${title} 재생`, 'title', () => begin(playable(list.items), id, list.name));
    play.disabled = !file;
    if (id === currentFile()) play.setAttribute('aria-current', 'true');
    const up = makeButton('↑', `${title} 위로`, 'icon', () => moveItem(list, index, -1));
    const down = makeButton('↓', `${title} 아래로`, 'icon', () => moveItem(list, index, 1));
    const remove = makeButton('×', `${title} 목록에서 빼기`, 'icon', () => {
      changeList(list, list.name, list.items.filter((item) => item !== id));
    });
    up.disabled = saving || index === 0;
    down.disabled = saving || index === list.items.length - 1;
    remove.disabled = saving;
    row.append(play, up, down, remove);
    return row;
  });
  $('list-items').replaceChildren(...rows);
}

function renderLibrary() {
  const search = $('search').value.trim().toLocaleLowerCase('ko');
  const results = library.filter(({ name }) => name.toLocaleLowerCase('ko').includes(search));
  $('library-count').textContent = search ? `${results.length} / ${library.length}` : `${library.length}개`;
  $('library-empty').hidden = Boolean(results.length);
  $('library-empty').textContent = search ? '검색과 일치하는 영상이 없습니다.' : '연결된 폴더에 재생할 MP4·MP3가 없습니다.';
  const list = selectedList();
  const selectedItems = new Set(list?.items);
  const rows = results.map(({ id, name }) => {
    const row = document.createElement('li');
    row.classList.toggle('current', id === currentFile());
    const play = makeButton(name, `${name} 재생`, 'title', () => begin(library.map((file) => file.id), id, '미디어 보관함'));
    if (id === currentFile()) play.setAttribute('aria-current', 'true');
    const added = selectedItems.has(id);
    const add = makeButton(added ? '✓' : '＋', `${name} ${added ? '담겨 있음' : '목록에 담기'}`, 'icon', () => {
      if (list) changeList(list, list.name, [...list.items, id]);
      else openDialog('create', id);
    });
    add.disabled = saving || added;
    row.append(play, add);
    return row;
  });
  $('library-items').replaceChildren(...rows);
}

function renderTransport() {
  $('previous').disabled = !queue;
  $('next').disabled = !queue || (repeat !== 2 && queue.index >= queue.order.length - 1);
  $('shuffle').setAttribute('aria-pressed', String(shuffle));
  $('repeat').textContent = `반복 ${repeatModes[repeat]}`;
  $('repeat').setAttribute('aria-label', `반복 모드 ${repeatModes[repeat]}`);
  $('repeat').classList.toggle('active', repeat !== 0);
  $('queue-info').textContent = queue ? `${queueName} · ${queue.index + 1} / ${queue.order.length}` : '';
  if ('mediaSession' in navigator) {
    setMediaAction('previoustrack', queue ? previousVideo : null);
    setMediaAction('nexttrack', queue && (repeat === 2 || queue.index < queue.order.length - 1) ? advance : null);
  }
}

function renderPip() {
  const active = pipActive();
  const external = !pipSupported() && isDiscordActivity;
  pipButton.setAttribute('aria-pressed', String(active));
  pipButton.textContent = external ? '브라우저에서 PiP' : active ? '작은 창 닫기' : '작은 창(PiP)';
  pipButton.disabled = changingPip || (!external && (!pipSupported() || (!active && (!video.videoWidth || !video.readyState))));
  $('playback-help').textContent = external
    ? '이 Discord 화면은 작은 창을 지원하지 않습니다. ‘브라우저로 이어재생’으로 이동해 영상을 재생한 뒤 작은 창을 눌러 주세요.'
    : !pipSupported()
      ? '이 브라우저는 작은 창 기능을 제공하지 않습니다. 최신 Chrome(Android) 또는 Safari(iPhone)에서 플레이어 주소를 열어 주세요.'
      : !video.readyState
        ? '영상을 선택하고 재생하면 작은 창 버튼을 사용할 수 있습니다.'
        : '작은 창을 연 뒤 홈 화면으로 이동하면 다른 앱과 함께 볼 수 있습니다. 화면 잠금·절전·기기 설정에 따라 재생이 멈출 수 있습니다.';
}

async function continueInBrowser() {
  if (openingBrowser) return;
  openingBrowser = true;
  $('open-browser').disabled = true;
  try {
    await openInBrowser(currentFile() ? { fileId: currentFile(), time: activeMedia().currentTime, playlistId: selectedId, repeat, shuffle } : null);
    if (currentFile()) activeMedia().pause();
  } finally { openingBrowser = false; $('open-browser').disabled = false; }
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const session = navigator.mediaSession;
  const media = activeMedia();
  session.playbackState = !queue ? 'none' : media.paused ? 'paused' : 'playing';
  if (session.setPositionState && Number.isFinite(media.duration) && media.duration > 0) {
    session.setPositionState({
      duration: media.duration,
      playbackRate: media.playbackRate,
      position: Math.min(media.currentTime, media.duration),
    });
  }
}

function render() {
  renderLists();
  renderLibrary();
  renderTransport();
}

function moveItem(list, index, offset) {
  const items = [...list.items];
  const other = index + offset;
  [items[index], items[other]] = [items[other], items[index]];
  changeList(list, list.name, items);
}

async function changeList(list, name, items) {
  if (saving) return;
  saving = true;
  notice();
  render();
  try {
    const updated = await api(list ? `playlists/${list.id}` : 'playlists', {
      method: list ? 'PUT' : 'POST', data: { name, items },
    });
    if (list) playlists = playlists.map((entry) => entry.id === list.id ? updated : entry);
    else playlists.push(updated);
    selectedId = updated.id;
    if (dialog.open) dialog.close();
  } catch (error) {
    if (dialog.open) dialog.close();
    explain(error);
  } finally {
    saving = false;
    render();
  }
}

function openDialog(action, fileId) {
  const list = selectedList();
  const deleting = action === 'delete';
  dialogAction = { action, fileId, list };
  $('dialog-title').textContent = { create: '새 재생목록', rename: '재생목록 이름 변경', delete: '재생목록 삭제' }[action];
  $('list-name').value = action === 'rename' ? list.name : '';
  $('list-name').required = !deleting;
  $('dialog-label').hidden = $('list-name').hidden = deleting;
  $('confirm').textContent = deleting ? '목록 삭제' : '저장';
  $('dialog-description').hidden = !deleting;
  $('dialog-description').textContent = deleting ? `‘${list.name}’ 목록을 삭제하시겠어요?` : '';
  dialog.showModal();
  if (!deleting) $('list-name').focus();
}

async function deleteList(list) {
  if (saving) return;
  saving = true;
  notice();
  dialog.close();
  render();
  try {
    await api(`playlists/${list.id}`, { method: 'DELETE' });
    playlists = playlists.filter(({ id }) => id !== list.id);
    selectedId = playlists[0]?.id || '';
  } catch (error) { explain(error); }
  finally { saving = false; render(); }
}

function playVideo() {
  activeMedia().play().catch((error) => {
    if (error.name === 'NotAllowedError') notice('재생기에서 ▶를 눌러 주세요.');
    else if (error.name !== 'AbortError') notice('영상을 재생할 수 없습니다. 파일 권한과 영상 코덱을 확인해 주세요.', true);
  });
}

async function loadCurrent(startTime = 0) {
  const version = ++loadVersion;
  const id = currentFile();
  $('placeholder').hidden = true;
  video.hidden = false;
  $('now-playing').textContent = filesById.get(id)?.name || '영상';
  notice('파일을 불러오는 중입니다…');
  render();
  try {
    await player.load(id);
    if (version !== loadVersion) return;
    updateMetadata();
    const media = activeMedia();
    if (startTime > 0) {
      const resume = () => {
        if (version === loadVersion && Number.isFinite(media.duration) && media.duration > 0) media.currentTime = Math.min(startTime, Math.max(0, media.duration - 0.25));
      };
      if (media.readyState) resume();
      else media.addEventListener('loadedmetadata', resume, { once: true });
    }
    notice();
    playVideo();
  } catch (error) { if (error.name !== 'AbortError' && version === loadVersion) explain(error); }
}

function begin(ids, selected, name, startTime = 0) {
  const started = startQueue(ids, selected, shuffle);
  if (!started) return;
  queue = started;
  queueName = name;
  loadCurrent(startTime);
}

function advance() {
  if (!queue) return;
  const next = nextQueue(queue, repeat === 2, shuffle);
  if (!next) return;
  queue = next;
  loadCurrent();
}

function previousVideo() {
  if (!queue) return;
  if (activeMedia().currentTime > 3 || queue.index === 0) { activeMedia().currentTime = 0; playVideo(); return; }
  queue = { ...queue, index: queue.index - 1 };
  loadCurrent();
}

function setLibrary(files) {
  library = files;
  filesById = new Map(files.map((file) => [file.id, file]));
  setMediaFiles(files);
}

async function init() {
  const connected = await connect();
  if (connected === 'pending') { $('connection').textContent = '배포 준비 중'; notice('서버 연결을 준비 중입니다. 배포가 끝난 뒤 다시 열어 주세요.'); return; }
  if (!connected) { $('connection').textContent = '로그인 필요'; return; }
  const { user, files, playlists: lists } = await bootstrap();
  if (files.some(file => file.kind !== 'audio')) prepareVideo().catch(() => {});
  $('connection').textContent = `Drive 연결됨 · ${user.name}`;
  $('login').hidden = true;
  setLibrary(files);
  playlists = lists;
  selectedId = playlists[0]?.id || '';
  render();
  renderPip();
  $('workspace').hidden = false;
  resumePlayback();
}

function resumePlayback() {
  const resume = takePlaybackResume();
  if (resume && filesById.has(resume.fileId)) {
    const list = playlists.find(list => list.id === resume.playlistId && list.items.includes(resume.fileId));
    if (list) selectedId = list.id;
    shuffle = resume.shuffle;
    repeat = resume.repeat;
    begin(list ? playable(list.items) : library.map(file => file.id), resume.fileId, list?.name || '미디어 보관함', resume.time);
  } else if (resume) notice('이전 영상을 연결된 Drive 폴더에서 찾을 수 없습니다.', true);
}

listPicker.addEventListener('change', () => { selectedId = listPicker.value; render(); });
$('new-list').addEventListener('click', () => openDialog('create'));
$('rename-list').addEventListener('click', () => openDialog('rename'));
$('delete-list').addEventListener('click', () => openDialog('delete'));
$('cancel').addEventListener('click', () => dialog.close());
$('list-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const { action, list, fileId } = dialogAction;
  if (action === 'delete') return deleteList(list);
  const name = $('list-name').value.trim();
  if (!name) return $('list-name').focus();
  if (action === 'rename') return changeList(list, name, list.items);
  return changeList(null, name, fileId ? [fileId] : []);
});
$('play-list').addEventListener('click', () => {
  const list = selectedList();
  begin(playable(list.items), null, list.name);
});
$('search').addEventListener('input', renderLibrary);
$('refresh').addEventListener('click', async () => {
  if (refreshing) return;
  refreshing = true;
  $('refresh').disabled = true;
  notice();
  try { setLibrary(await api('library?refresh')); render(); }
  catch (error) { explain(error); }
  finally { refreshing = false; $('refresh').disabled = false; }
});
$('shuffle').addEventListener('click', () => {
  shuffle = !shuffle;
  if (queue) queue = reorderQueue(queue, shuffle);
  renderTransport();
});
$('repeat').addEventListener('click', () => { repeat = (repeat + 1) % repeatModes.length; renderTransport(); });
$('previous').addEventListener('click', previousVideo);
$('next').addEventListener('click', advance);
pipButton.addEventListener('click', async () => {
  changingPip = true;
  renderPip();
  try {
    if (!pipSupported() && isDiscordActivity) await continueInBrowser();
    else if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
    else if (video.webkitPresentationMode === 'picture-in-picture') video.webkitSetPresentationMode('inline');
    else if (standardPip) await video.requestPictureInPicture();
    else video.webkitSetPresentationMode('picture-in-picture');
  } catch (error) {
    if (!pipSupported() && isDiscordActivity) explain(error);
    else notice(error.name === 'NotAllowedError' ? '재생기에서 영상을 시작한 뒤 작은 창 버튼을 눌러 주세요.' : '작은 창을 열 수 없습니다. 브라우저에서 열어 다시 시도해 주세요.', true);
  } finally {
    changingPip = false;
    renderPip();
  }
});
for (const name of ['enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged', 'loadedmetadata', 'emptied']) {
  video.addEventListener(name, renderPip);
}
for (const name of ['play', 'pause', 'ended', 'loadedmetadata', 'timeupdate', 'ratechange', 'seeked']) {
  video.addEventListener(name, updateMediaSession);
  audio.addEventListener(name, updateMediaSession);
}
audio.addEventListener('play', () => { if (audioMode && coverPip.stream) video.play().catch(() => {}); });
audio.addEventListener('pause', () => { if (audioMode && coverPip.stream) video.pause(); });
video.addEventListener('play', () => { if (audioMode && pipActive() && audio.paused) playVideo(); });
video.addEventListener('pause', () => { if (audioMode && pipActive() && !audio.paused) audio.pause(); });
if ('mediaSession' in navigator) {
  const seek = (position) => {
    const media = activeMedia();
    if (Number.isFinite(media.duration)) media.currentTime = Math.max(0, Math.min(position, media.duration));
  };
  const actions = {
    play: () => { if (queue) playVideo(); },
    pause: () => activeMedia().pause(),
    stop: () => { activeMedia().pause(); seek(0); },
    seekto: ({ seekTime }) => seek(seekTime),
    seekbackward: ({ seekOffset = 10 }) => seek(activeMedia().currentTime - seekOffset),
    seekforward: ({ seekOffset = 10 }) => seek(activeMedia().currentTime + seekOffset),
  };
  for (const [action, handler] of Object.entries(actions)) {
    setMediaAction(action, handler);
  }
}
function ended(event) {
  if (event.target !== activeMedia()) return;
  if (repeat === 1) { activeMedia().currentTime = 0; playVideo(); }
  else advance();
}
video.addEventListener('ended', ended);
audio.addEventListener('ended', ended);
video.addEventListener('error', () => { if (!audioMode) notice('영상을 불러오지 못했습니다. 연결 상태와 파일 권한을 확인해 주세요.', true); });
audio.addEventListener('error', () => { if (audioMode && audio.hasAttribute('src')) notice('MP3를 불러오지 못했습니다. 연결 상태를 확인하거나 외부 Chrome·Safari에서 다시 열어 주세요.', true); });

let savingCover = false;
async function changeCover(selected) {
  if (savingCover || !audioMode) return;
  const id = currentFile(), file = filesById.get(id);
  savingCover = true;
  $('choose-cover').disabled = $('reset-cover').disabled = true;
  try {
    let blob = null;
    if (selected) blob = await covers.save(file, selected);
    else { await api(`audio-covers/${id}`, { method: 'DELETE' }); delete file.coverVersion; }
    if (audioMode && currentFile() === id) { ++covers.version; covers.set(blob); }
    notice('MP3 이미지가 저장되었습니다.');
  } catch (error) { explain(error); }
  finally { savingCover = false; $('choose-cover').disabled = $('reset-cover').disabled = false; $('cover-input').value = ''; }
}
$('choose-cover').addEventListener('click', () => $('cover-input').click());
$('cover-input').addEventListener('change', () => { if ($('cover-input').files[0]) changeCover($('cover-input').files[0]); });
$('reset-cover').addEventListener('click', () => changeCover(null));
init().catch((error) => { $('connection').textContent = '연결 실패'; explain(error); });

$('login').addEventListener('click', () => startLogin().catch(explain));
$('browser-handoff').hidden = !isDiscordActivity;
$('open-browser').addEventListener('click', () => continueInBrowser().catch(explain));
window.addEventListener('hashchange', () => {
  if (capturePlaybackResume() && !$('workspace').hidden) resumePlayback();
});
window.addEventListener('pagehide', () => player.close());
