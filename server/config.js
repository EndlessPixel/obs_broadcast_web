'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

// 轻量 .env 读取（不引入依赖），已存在的环境变量优先
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    const eq = text.indexOf('=');
    if (!text || text.startsWith('#') || eq < 1) continue;
    const key = text.slice(0, eq).trim();
    const value = text.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function floatEnv(name, fallback) {
  const value = Number.parseFloat(process.env[name] || '');
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

module.exports = {
  root,
  httpPort: intEnv('HTTP_PORT', 3100),
  rtmpPort: intEnv('RTMP_PORT', 1935),
  rtmpApp: 'live',
  // 为空表示不校验推流密钥；设置后 OBS 的串流密钥需写成 "频道名?token=<STREAM_TOKEN>"
  streamToken: process.env.STREAM_TOKEN || '',
  defaultChannel: 'studio',
  hlsTime: intEnv('HLS_TIME', 2),
  hlsListSize: intEnv('HLS_LIST_SIZE', 5),
  // 4GB 小机器上限制并发推流数量，避免多个 ffmpeg 同时占用内存
  maxStreams: intEnv('MAX_STREAMS', 3),
  // 服务器上行带宽（实测 8Mbps），用于建议码率与可承载观看人数估算
  uplinkMbps: floatEnv('UPLINK_MBPS', 8),
  ffmpeg: process.env.FFMPEG || 'ffmpeg',
  publicDir: path.join(root, 'public'),
  // 生产环境可设 HLS_DIR=/dev/shm/obs-live-hls，分片写内存盘，避免磁盘 IO
  hlsDir: process.env.HLS_DIR ? path.resolve(process.env.HLS_DIR) : path.join(root, 'public', 'hls'),
  dataDir: path.join(root, 'data'),
  recordDir: path.join(root, 'record'),
  vendorDir: path.join(root, 'node_modules', 'hls.js', 'dist'),
};
