/* 独立作用域：app.js 也在全局声明了 const $，defer 脚本共享全局词法环境，重复声明会让整个脚本不执行 */
(() => {
'use strict';

const $ = (selector) => document.querySelector(selector);
const USER_KEY = 'obs-live-chat-user';
const UID_KEY = 'obs-live-chat-uid';
const VALID_CHANNEL = /^[A-Za-z0-9_-]{1,48}$/;

function storageGet(key) {
  try { return localStorage.getItem(key) || ''; } catch (_err) { return ''; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch (_err) { /* 隐私模式下忽略 */ }
}
function randomUid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

let uid = storageGet(UID_KEY);
if (!uid) {
  uid = randomUid();
  storageSet(UID_KEY, uid);
}
let username = storageGet(USER_KEY);
let channel = window.obsLiveChannel || new URLSearchParams(location.search).get('channel') || 'studio';
if (!VALID_CHANNEL.test(channel)) channel = 'studio';

let lastId = 0;
let epoch = '';
let polling = false;
const seen = new Set();

const messagesEl = $('#chat-messages');
const formEl = $('#chat-form');
const textEl = $('#chat-text');
const sendEl = $('#chat-send');
const statusEl = $('#chat-status');
const onlineEl = $('#chat-online');
const onlineMetaEl = $('#chat-online-meta');
const joinOverlay = $('#join-overlay');
const joinName = $('#join-name');
const joinError = $('#join-error');

function setStatus(text) { statusEl.textContent = text; }

function setOnline(count) {
  const label = `${count} 人`;
  onlineEl.textContent = `在线 ${label}`;
  onlineMetaEl.textContent = label;
}

function setJoined(joined) {
  textEl.disabled = !joined;
  sendEl.disabled = !joined;
  joinOverlay.hidden = joined;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function clearMessages() {
  messagesEl.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'chat-empty';
  empty.textContent = '还没有消息，来说第一句吧';
  messagesEl.appendChild(empty);
}

function appendMessage(message) {
  if (!message || seen.has(message.id)) return;
  seen.add(message.id);
  messagesEl.querySelector('.chat-empty')?.remove();
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;

  const row = document.createElement('div');
  row.className = 'chat-message';
  const time = document.createElement('span');
  time.className = 'chat-time';
  time.textContent = formatTime(message.ts);
  const user = document.createElement('span');
  user.className = 'chat-user';
  user.textContent = message.user;
  const text = document.createElement('span');
  text.className = 'chat-text';
  text.textContent = message.text;
  row.append(time, user, text);
  messagesEl.appendChild(row);

  while (messagesEl.children.length > 120) messagesEl.removeChild(messagesEl.firstChild);
  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function poll() {
  if (polling || document.hidden) return;
  polling = true;
  const requestedChannel = channel;
  const params = new URLSearchParams({ since: String(lastId), uid });
  if (username) params.set('name', username);
  try {
    const response = await fetch(`/api/chat/${encodeURIComponent(requestedChannel)}?${params}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (requestedChannel !== channel) return;

    // 服务端重启后消息 id 会归零，按 epoch 重置本地游标
    if (data.epoch && epoch && data.epoch !== epoch) {
      lastId = 0;
      seen.clear();
      clearMessages();
    }
    if (data.epoch) epoch = data.epoch;

    if (Array.isArray(data.messages)) {
      for (const message of data.messages) {
        appendMessage(message);
        if (message.id > lastId) lastId = message.id;
      }
    }
    setOnline(Number(data.online) || 0);
    setStatus(username ? '已连接' : '只读，输入用户名后可发言');
  } catch (_err) {
    setStatus('连接中…');
  } finally {
    polling = false;
  }
}

function leaveCurrent() {
  if (!username) return;
  fetch(`/api/chat/${encodeURIComponent(channel)}/leave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid }),
  }).catch(() => {});
}

function switchChannel(next) {
  if (!VALID_CHANNEL.test(next) || next === channel) return;
  leaveCurrent();
  channel = next;
  lastId = 0;
  epoch = '';
  seen.clear();
  clearMessages();
  setOnline(0);
  poll();
}

function showJoin(errorText = '') {
  joinName.value = username;
  joinError.textContent = errorText;
  joinError.hidden = !errorText;
  setJoined(false);
  setTimeout(() => joinName.focus(), 0);
}

function submitJoin() {
  const name = joinName.value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
  if (!name) {
    joinError.textContent = '请输入用户名';
    joinError.hidden = false;
    return;
  }
  username = name;
  storageSet(USER_KEY, name);
  setJoined(true);
  setStatus('已加入，正在同步…');
  poll();
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!username) {
    showJoin();
    return;
  }
  const text = textEl.value.trim();
  if (!text) return;
  sendEl.disabled = true;
  try {
    const response = await fetch(`/api/chat/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, name: username, text }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      setStatus(data.error || '发送失败');
      return;
    }
    appendMessage(data.message);
    if (data.message.id > lastId) lastId = data.message.id;
    textEl.value = '';
    setStatus('已连接');
  } catch (_err) {
    setStatus('发送失败，稍后重试');
  } finally {
    sendEl.disabled = !username;
    textEl.focus();
  }
});

$('#join-btn').addEventListener('click', submitJoin);
joinName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitJoin();
});
$('#rename-btn').addEventListener('click', () => showJoin());
document.addEventListener('channelchange', (event) => switchChannel(event.detail?.channel));
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
window.addEventListener('pagehide', leaveCurrent);

if (username) setJoined(true);
else showJoin();
poll();
setInterval(poll, 2000);
})();
