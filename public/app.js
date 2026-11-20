'use strict';

const $ = (selector) => document.querySelector(selector);
const VALID_NAME = /^[A-Za-z0-9_-]{1,48}$/;

const state = {
  channel: new URLSearchParams(location.search).get('channel') || '',
  pinned: new URLSearchParams(location.search).has('channel'),
  channels: [],
  hls: null,
  currentUrl: null,
  retryTimer: null,
};

let lastChatChannel = '';
function syncChatChannel() {
  if (!state.channel) return;
  window.obsLiveChannel = state.channel;
  if (state.channel !== lastChatChannel) {
    lastChatChannel = state.channel;
    document.dispatchEvent(new CustomEvent('channelchange', { detail: { channel: state.channel } }));
  }
}
syncChatChannel();

function duration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function notice(text) {
  const el = $('#notice');
  el.textContent = text || '';
  el.hidden = !text;
}

function serverStatus(online) {
  $('#server-text').textContent = online ? '服务运行中' : '服务连接失败';
  $('#server-pill').classList.toggle('offline', !online);
}

function renderChannels() {
  const list = $('#channel-list');
  $('#channel-count').textContent = String(state.channels.length);

  if (!state.channels.length) {
    list.innerHTML = '<p class="empty">暂无频道在线</p>';
    return;
  }
  list.innerHTML = '';
  for (const channel of state.channels) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `channel-item${channel.name === state.channel ? ' active' : ''}${channel.status === 'buffering' ? ' buffering' : ''}`;
    const subtitle = channel.status === 'live'
      ? `已开播 ${duration(Date.now() - channel.startedAt)}`
      : '信号重连中...';
    button.innerHTML = `<span class="channel-dot"></span>
      <span class="channel-text"><strong></strong><small>${subtitle}</small></span>
      <span class="channel-arrow">›</span>`;
    button.querySelector('strong').textContent = channel.name;
    button.addEventListener('click', () => selectChannel(channel.name, true));
    list.appendChild(button);
  }
}

function shortTime(ts) {
  const date = new Date(ts);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderHistory(list) {
  const el = $('#history-list');
  $('#history-count').textContent = String(list.length);
  if (!list.length) {
    el.innerHTML = '<p class="empty">暂无开播记录</p>';
    return;
  }
  el.replaceChildren();
  for (const item of list) {
    const row = document.createElement('div');
    row.className = `history-item${item.ongoing ? ' ongoing' : ''}`;
    const dot = document.createElement('span');
    dot.className = 'history-dot';
    const main = document.createElement('div');
    main.className = 'history-main';
    const title = document.createElement('strong');
    title.textContent = item.channel;
    const sub = document.createElement('small');
    const quality = item.width && item.height ? ` · ${item.width}×${item.height}` : '';
    sub.textContent = `${shortTime(item.startedAt)} 开播${quality}`;
    main.append(title, sub);
    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = item.ongoing ? `直播中 ${duration(item.durationMs)}` : duration(item.durationMs);
    row.append(dot, main, time);
    el.appendChild(row);
  }
}

async function refreshHistory() {
  try {
    const response = await fetch('/api/history?limit=20', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (Array.isArray(data.history)) renderHistory(data.history);
  } catch (_err) { /* 历史加载失败不影响播放器 */ }
}

function renderCapacity(capacity) {
  const cap = capacity || {};
  $('#uplink').textContent = `${cap.uplinkMbps || '--'} Mbps`;

  const channel = state.channels.find((item) => item.name === state.channel) || state.channels[0];
  const inBps = channel && channel.inBps > 0 ? channel.inBps : 0;
  $('#in-bitrate').textContent = inBps ? `${(inBps * 8 / 1e6).toFixed(2)} Mbps` : '--';

  const hasCapacity = Number.isFinite(cap.maxViewers);
  const viewers = hasCapacity
    ? cap.maxViewers
    : (inBps ? Math.floor((cap.uplinkMbps || 0) * 1e6 * 0.85 / (inBps * 8)) : 0);
  $('#max-viewers').textContent = (inBps || hasCapacity) ? `≤ ${viewers} 人` : '--';

  const hint = $('#bandwidth-hint');
  if (cap.overBitrate) {
    hint.textContent = `当前码率 ${cap.currentBitrateKbps} Kbps 高于建议 ${cap.recommendedBitrateKbps} Kbps，请在 OBS 降低码率，否则观众容易卡顿。`;
    hint.classList.add('warn');
    hint.hidden = false;
  } else if (cap.lowBandwidth) {
    hint.textContent = `${cap.uplinkMbps}Mbps 上行：建议码率 ≤ ${cap.recommendedBitrateKbps} Kbps，已启用省流轮询。`;
    hint.classList.remove('warn');
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
}

function selectChannel(name, pin) {
  if (!VALID_NAME.test(name)) {
    notice('频道名只能包含字母、数字、下划线和短横线（最长 48 位）。');
    return;
  }
  state.channel = name;
  if (pin) state.pinned = true;
  const params = new URLSearchParams(location.search);
  params.set('channel', name);
  history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
  syncChatChannel();
  detachPlayer();
  renderChannels();
  renderPlayer();
}

function detachPlayer() {
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  const video = $('#player');
  video.pause();
  video.removeAttribute('src');
  video.load();
  state.currentUrl = null;
}

function attachPlayer(url) {
  detachPlayer();
  const video = $('#player');
  state.currentUrl = url;

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({
      lowLatencyMode: true,
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 6,
      maxBufferLength: 8,
      backBufferLength: 10,
      enableWorker: true,
    });
    state.hls = hls;
    hls.on(window.Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(url));
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });
    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        notice('播放连接中断，正在自动重连...');
        detachPlayer();
        state.retryTimer = setTimeout(() => renderPlayer(), 1500);
      }
    });
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.play().catch(() => {});
  } else {
    notice('当前浏览器不支持 HLS 播放，请使用 Chrome / Edge / Safari 的新版本。');
  }
}

function renderPlayer() {
  const channel = state.channels.find((item) => item.name === state.channel);
  const live = channel && channel.status === 'live' && channel.playlist;

  $('#channel-title').textContent = state.channel;
  $('#channel-name').textContent = state.channel;
  $('#live-badge').classList.toggle('on', Boolean(live));
  $('#live-badge').innerHTML = `<i></i>${live ? '直播中' : (channel ? '信号重连中' : '等待信号')}`;

  if (live) {
    $('#overlay').hidden = true;
    $('#uptime').textContent = duration(Date.now() - channel.startedAt);
    $('#resolution').textContent = channel.width && channel.height ? `${channel.width}×${channel.height}` : '--';
    if (state.currentUrl !== channel.playlist) {
      notice('');
      attachPlayer(channel.playlist);
    }
  } else {
    if (state.currentUrl) detachPlayer();
    $('#overlay').hidden = false;
    $('#overlay-title').textContent = channel ? '信号重连中' : '等待推流信号';
    $('#overlay-text').textContent = channel
      ? '推流端连接不稳定，恢复后会自动继续播放。'
      : '等待推流信号，连接信息请在服务器终端查看。';
    $('#uptime').textContent = channel ? duration(Date.now() - channel.startedAt) : '--:--:--';
    $('#resolution').textContent = '--';
  }
}

async function refresh() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    serverStatus(true);
    if ($('#notice').textContent.includes('无法获取服务状态')) notice('');
    state.channels = data.channels;

    if (!state.channel) state.channel = data.defaults.channel;
    if (!state.pinned) {
      const firstLive = state.channels.find((item) => item.status === 'live');
      if (firstLive && !state.channels.some((item) => item.name === state.channel)) {
        state.channel = firstLive.name;
      }
    }

    syncChatChannel();
    $('#segment-tag').textContent = `分片 ${data.defaults.hlsTime}s`;
    renderCapacity(data.capacity);
    renderChannels();
    renderPlayer();
  } catch (err) {
    serverStatus(false);
    notice('无法获取服务状态，请确认后端正在运行。');
  }
}

$('#reload-btn').addEventListener('click', () => {
  detachPlayer();
  notice('');
  renderPlayer();
});
$('#mute-btn').addEventListener('click', () => {
  const video = $('#player');
  video.muted = !video.muted;
  $('#mute-btn').textContent = video.muted ? '取消静音' : '静音';
  if (!video.muted) video.play().catch(() => {});
});
$('#fullscreen-btn').addEventListener('click', () => {
  const shell = $('#player-shell');
  if (document.fullscreenElement) document.exitFullscreen();
  else shell.requestFullscreen?.();
});

setInterval(() => {
  $('#clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const channel = state.channels.find((item) => item.name === state.channel);
  if (channel) $('#uptime').textContent = duration(Date.now() - channel.startedAt);
}, 1000);

refresh();
refreshHistory();
setInterval(refresh, 4000);
setInterval(refreshHistory, 15000);
