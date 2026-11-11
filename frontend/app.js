import { nextQueue, reorderQueue, startQueue } from './queue.js';
import { api, connect, startLogin } from './transport.js';
import { DrivePlayer } from './media.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const listPicker = $('list-picker');
const dialog = $('list-dialog');
const pipButton = $('pip');
const pipSupported = Boolean(document.pictureInPictureEnabled && video.requestPictureInPicture);
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


function notice(message = '', error = false) {
  const element = $('notice');
  element.hidden = !message;
  element.textContent = message;
  element.classList.toggle('error', error);
}

function explain(error) { notice(error.message, true); }
const player = new DrivePlayer(video, explain);
let loadVersion = 0;

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
  $('list-empty').textContent = list ? '아래 보관함에서 ＋를 눌러 영상을 담으세요.' : '새 목록을 만들면 원하는 영상만 모아둘 수 있습니다.';
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
  $('library-empty').textContent = search ? '검색과 일치하는 영상이 없습니다.' : '연결된 폴더에 재생할 MP4가 없습니다.';
  const list = selectedList();
  const selectedItems = new Set(list?.items);
  const rows = results.map(({ id, name }) => {
    const row = document.createElement('li');
    row.classList.toggle('current', id === currentFile());
    const play = makeButton(name, `${name} 재생`, 'title', () => begin(library.map((file) => file.id), id, '영상 보관함'));
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
  const active = document.pictureInPictureElement === video;
  pipButton.setAttribute('aria-pressed', String(active));
  pipButton.textContent = active ? '작은 창 닫기' : '작은 창(PiP)';
  pipButton.disabled = changingPip || !pipSupported || (!active && (!video.videoWidth || !video.readyState));
  if (!pipSupported) {
    $('playback-help').textContent = '이 브라우저에서는 작은 창을 사용할 수 없습니다. Chrome 또는 Edge에서 열어 주세요. 탭을 열어두면 다른 작업 중에도 재생됩니다.';
  }
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const session = navigator.mediaSession;
  session.playbackState = !queue ? 'none' : video.paused ? 'paused' : 'playing';
  if (session.setPositionState && Number.isFinite(video.duration) && video.duration > 0) {
    session.setPositionState({
      duration: video.duration,
      playbackRate: video.playbackRate,
      position: Math.min(video.currentTime, video.duration),
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
  video.play().catch((error) => {
    if (error.name === 'NotAllowedError') notice('재생기에서 ▶를 눌러 주세요.');
    else if (error.name !== 'AbortError') notice('영상을 재생할 수 없습니다. 파일 권한과 영상 코덱을 확인해 주세요.', true);
  });
}

async function loadCurrent() {
  const version = ++loadVersion;
  const id = currentFile();
  $('placeholder').hidden = true;
  video.hidden = false;
  $('now-playing').textContent = filesById.get(id)?.name || '영상';
  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: $('now-playing').textContent, artist: 'Drive Screen', album: queueName });
  }
  notice('영상을 불러오는 중입니다…');
  render();
  try {
    await player.load(id);
    if (version !== loadVersion) return;
    notice();
    playVideo();
  } catch (error) { if (error.name !== 'AbortError' && version === loadVersion) explain(error); }
}

function begin(ids, selected, name) {
  const started = startQueue(ids, selected, shuffle);
  if (!started) return;
  queue = started;
  queueName = name;
  loadCurrent();
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
  if (video.currentTime > 3 || queue.index === 0) { video.currentTime = 0; playVideo(); return; }
  queue = { ...queue, index: queue.index - 1 };
  loadCurrent();
}

function setLibrary(files) {
  library = files;
  filesById = new Map(files.map((file) => [file.id, file]));
}

async function init() {
  const connected = await connect();
  if (connected === 'pending') { $('connection').textContent = '배포 준비 중'; notice('서버 연결을 준비 중입니다. 배포가 끝난 뒤 다시 열어 주세요.'); return; }
  if (!connected) { $('connection').textContent = '로그인 필요'; return; }
  const [user, files, lists] = await Promise.all([api('me'), api('library'), api('playlists')]);
  $('connection').textContent = `Drive 연결됨 · ${user.name}`;
  $('login').hidden = true;
  setLibrary(files);
  playlists = lists;
  selectedId = playlists[0]?.id || '';
  render();
  renderPip();
  $('workspace').hidden = false;
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
    if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  } catch (error) {
    notice(error.name === 'NotAllowedError' ? '재생기에서 영상을 시작한 뒤 작은 창 버튼을 눌러 주세요.' : '작은 창을 열 수 없습니다. Chrome 또는 Edge에서 다시 시도해 주세요.', true);
  } finally {
    changingPip = false;
    renderPip();
  }
});
for (const name of ['enterpictureinpicture', 'leavepictureinpicture', 'loadedmetadata', 'emptied']) {
  video.addEventListener(name, renderPip);
}
for (const name of ['play', 'pause', 'ended', 'loadedmetadata', 'timeupdate', 'ratechange', 'seeked']) {
  video.addEventListener(name, updateMediaSession);
}
if ('mediaSession' in navigator) {
  const seek = (position) => {
    if (Number.isFinite(video.duration)) video.currentTime = Math.max(0, Math.min(position, video.duration));
  };
  const actions = {
    play: () => { if (queue) playVideo(); },
    pause: () => video.pause(),
    stop: () => { video.pause(); seek(0); },
    seekto: ({ seekTime }) => seek(seekTime),
    seekbackward: ({ seekOffset = 10 }) => seek(video.currentTime - seekOffset),
    seekforward: ({ seekOffset = 10 }) => seek(video.currentTime + seekOffset),
  };
  for (const [action, handler] of Object.entries(actions)) {
    setMediaAction(action, handler);
  }
}
video.addEventListener('ended', () => {
  if (repeat === 1) { video.currentTime = 0; playVideo(); }
  else advance();
});
video.addEventListener('error', () => notice('영상을 불러오지 못했습니다. 연결 상태와 파일 권한을 확인해 주세요.', true));
init().catch((error) => { $('connection').textContent = '연결 실패'; explain(error); });

$('login').addEventListener('click', () => startLogin().catch(explain));
window.addEventListener('pagehide', () => player.close());
