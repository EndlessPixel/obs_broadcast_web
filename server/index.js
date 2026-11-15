'use strict';

const express = require('express');
const os = require('node:os');
const path = require('node:path');
const NodeMediaServer = require('node-media-server');
const nmsLogger = require('node-media-server/src/core/logger.js');
const { rateSampler } = require('node-media-server/src/core/rate_sampler.js');
const config = require('./config');
const StreamManager = require('./stream-manager');
const ChatStore = require('./chat-store');

const log = (message) => console.log(`[live ${new Date().toLocaleTimeString('zh-CN')}] ${message}`);
const manager = new StreamManager(config, log);
const chat = new ChatStore(config, log);
const recommendedBitrateKbps = Math.min(3000, Math.round(config.uplinkMbps * 200));

function lanAddresses() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if ((item.family === 'IPv4' || item.family === 4) && !item.internal) {
        addresses.push(item.address);
      }
    }
  }
  return addresses;
}

try {
  manager.ensureFfmpeg();
} catch (err) {
  console.error(`[live] ${err.message}`);
  process.exit(1);
}
manager.cleanStalePlaylists();

// RTMP 服务：接收 OBS 推流；HLS 文件由 ffmpeg 转封装后交给下面的 Web 服务分发
const nms = new NodeMediaServer({
  bind: '0.0.0.0',
  rtmp: { port: config.rtmpPort },
  store: { path: config.dataDir, maxHistory: 50 },
  webadmin: { enable: false },
  auth: { play: false, publish: false },
});
nmsLogger.level = 'warn';

nms.on('postPublish', (session) => {
  const name = session.streamName;
  const reject = (reason) => {
    log(`拒绝推流 ${session.streamPath}: ${reason}`);
    session.close();
  };

  if (session.streamApp !== config.rtmpApp || !StreamManager.validName(name)) {
    reject('推流地址或频道名不合法');
    return;
  }
  if (config.streamToken && session.streamQuery?.token !== config.streamToken) {
    reject('推流密钥不正确');
    return;
  }
  if (!manager.has(name) && manager.activeCount() >= config.maxStreams) {
    reject(`并发频道已达上限 ${config.maxStreams}`);
    return;
  }
  manager.start(name, session);
});

nms.on('donePublish', (session) => manager.stop(session.streamName));
nms.run();

const app = express();
app.disable('x-powered-by');
app.use('/vendor', express.static(config.vendorDir, { maxAge: '7d', index: false }));

// 播放列表允许重验证（内容未变时 express.static 返回 304 无响应体），分片短缓存
app.use('/hls', express.static(config.hlsDir, {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate, max-age=0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=2');
    }
  },
}));

// 连接信息只在终端输出，API 不返回服务器地址、端口或密钥
app.get('/api/state', (_req, res) => {
  const channels = manager.list().map((channel) => ({
    ...channel,
    inBps: rateSampler.getStreamRates(`/${config.rtmpApp}/${channel.name}`).inBps,
  }));
  // 每位 HLS 观众消耗一份推流码率；预留 15% 给协议开销与页面请求
  const liveChannel = channels.find((channel) => channel.inBps > 0);
  const currentBitrateKbps = liveChannel ? Math.round(liveChannel.inBps * 8 / 1000) : 0;
  const usableBps = config.uplinkMbps * 1e6 * 0.85;
  const maxViewers = currentBitrateKbps > 0
    ? Math.max(0, Math.floor(usableBps / (currentBitrateKbps * 1000)))
    : null;
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    channels,
    capacity: {
      uplinkMbps: config.uplinkMbps,
      maxStreams: config.maxStreams,
      recommendedBitrateKbps,
      lowBandwidth: config.uplinkMbps <= 10,
      currentBitrateKbps,
      maxViewers,
      overBitrate: currentBitrateKbps > recommendedBitrateKbps * 1.15,
    },
    defaults: {
      channel: config.defaultChannel,
      hlsTime: config.hlsTime,
      hlsListSize: config.hlsListSize,
    },
  });
});

app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, channels: manager.list().length });
});

// 评论区：按频道隔离，写入 data/chat/<频道>.jsonl，服务重启即清空
app.use('/api/chat', express.json({ limit: '4kb' }));
app.get('/api/chat/:channel', (req, res) => {
  const channelName = req.params.channel;
  if (!ChatStore.validChannel(channelName)) {
    return res.status(400).json({ ok: false, error: '频道名不合法' });
  }
  const since = Number.parseInt(String(req.query.since || '0'), 10) || 0;
  const uid = String(req.query.uid || '').slice(0, 64);
  const username = String(req.query.name || '').slice(0, 16);
  const online = chat.touch(channelName, uid, username);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, epoch: chat.epoch, messages: chat.messages(channelName, since), online });
});

app.post('/api/chat/:channel', (req, res) => {
  const channelName = req.params.channel;
  if (!ChatStore.validChannel(channelName)) {
    return res.status(400).json({ ok: false, error: '频道名不合法' });
  }
  const result = chat.post(channelName, req.body);
  res.status(result.status || 200).json(result.ok
    ? { ok: true, message: result.message }
    : { ok: false, error: result.error });
});

app.post('/api/chat/:channel/leave', (req, res) => {
  const channelName = req.params.channel;
  if (!ChatStore.validChannel(channelName)) {
    return res.status(400).json({ ok: false, error: '频道名不合法' });
  }
  chat.leave(channelName, String(req.body?.uid || '').slice(0, 64));
  res.json({ ok: true });
});

app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.use(express.static(config.publicDir, { index: 'index.html', maxAge: 0 }));

const server = app.listen(config.httpPort, '0.0.0.0', () => {
  const addresses = lanAddresses();
  const host = addresses[0] || '127.0.0.1';
  const rtmpUrl = (address) => `rtmp://${address}:${config.rtmpPort}/${config.rtmpApp}`;
  const streamKey = config.streamToken
    ? `${config.defaultChannel}?token=${config.streamToken}`
    : config.defaultChannel;

  log('==== OBS 连接信息（仅终端显示，网页 / API 不返回）====');
  log(`  服务器:   ${rtmpUrl(host)}`);
  log(`  同机推流: ${rtmpUrl('127.0.0.1')}`);
  if (addresses.length > 1) log(`  其他网卡: ${addresses.slice(1).map(rtmpUrl).join('  ')}`);
  log(`  串流密钥: ${streamKey}${config.streamToken ? '' : '（未启用鉴权）'}`);
  log(`  观看页:   http://${host}:${config.httpPort}`);
  log(`  建议码率: ${recommendedBitrateKbps} Kbps / 上行 ${config.uplinkMbps}Mbps / 最多 ${config.maxStreams} 路`);
  log(`  省流模式: ${config.uplinkMbps <= 10 ? '已启用（轮询间隔拉长，页面显示码率超限提示）' : '关闭'}`);
  log(`  HLS 目录: ${config.hlsDir}`);
  log(`  评论区: ${path.join(config.dataDir, 'chat')}（按频道隔离，重启清空）`);
  if (config.streamToken) log('  注意: 日志包含密钥，请限制终端 / journald 的访问权限');
  else log('  提示: 公网部署请设置 STREAM_TOKEN，并只向推流端开放 1935 端口');
});

server.on('error', (err) => {
  console.error(`[live] Web 服务启动失败: ${err.message}`);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('正在停止服务...');
  manager.stopAll();
  server.close();
  await nms.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
