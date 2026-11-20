'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const VALID_NAME = /^[A-Za-z0-9_-]{1,48}$/;
const MAX_RETRIES = 8;

class StreamManager {
  constructor(config, log = console.log) {
    this.config = config;
    this.log = log;
    this.channels = new Map();
    // 播放列表长时间不更新说明推流已停止（RTMP 拉流端可能仍挂着不退出）
    this.staleMs = Math.max(6000, config.hlsTime * 3000);
    this.startupMs = Math.max(10000, config.hlsTime * 5000);
    fs.mkdirSync(config.hlsDir, { recursive: true });
  }

  static validName(name) {
    return typeof name === 'string' && VALID_NAME.test(name);
  }

  has(name) {
    return this.channels.has(name);
  }

  activeCount() {
    let count = 0;
    for (const channel of this.channels.values()) {
      if (channel.online) count += 1;
    }
    return count;
  }

  ensureFfmpeg() {
    const result = spawnSync(this.config.ffmpeg, ['-version'], { stdio: 'ignore' });
    if (result.error || result.status !== 0) {
      throw new Error(
        `找不到可用的 ffmpeg（${this.config.ffmpeg}）：${result.error ? result.error.message : '退出码 ' + result.status}。请安装 ffmpeg 或用 FFMPEG 指定路径。`
      );
    }
  }

  cleanStalePlaylists() {
    for (const entry of fs.readdirSync(this.config.hlsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        fs.rmSync(path.join(this.config.hlsDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  start(name, session) {
    if (!StreamManager.validName(name)) return false;

    const existing = this.channels.get(name);
    if (existing) {
      // OBS 断线重连：取消清理计划，沿用同一个频道继续输出
      this.clearTimers(existing);
      existing.stopped = false;
      existing.online = true;
      existing.failures = 0;
      existing.retryDeadline = 0;
      existing.session = session;
      if (!existing.process) this.launch(existing);
      return true;
    }

    const dir = path.join(this.config.hlsDir, name);
    const channel = {
      name,
      session,
      dir,
      playlist: path.join(dir, 'index.m3u8'),
      startedAt: Date.now(),
      online: true,
      stopped: false,
      ready: false,
      failures: 0,
      retryDeadline: 0,
      process: null,
      retryTimer: null,
      readyTimer: null,
      cleanupTimer: null,
      lastError: '',
      lastMtime: 0,
      lastOutputAt: 0,
      processStartedAt: 0,
    };
    fs.mkdirSync(dir, { recursive: true });
    this.channels.set(name, channel);
    this.launch(channel);
    this.log(`频道上线: ${name}`);
    return true;
  }

  launch(channel) {
    if (channel.stopped || channel.process) return;
    clearTimeout(channel.retryTimer);
    channel.retryTimer = null;
    // 旧播放列表不能算作新一次转封装的成功，否则断流后页面会一直显示过期画面
    fs.rmSync(channel.playlist, { force: true });
    channel.ready = false;
    channel.lastMtime = 0;
    channel.lastOutputAt = 0;
    channel.processStartedAt = Date.now();

    const cfg = this.config;
    const args = [
      '-hide_banner', '-loglevel', 'warning', '-nostdin', '-y',
      '-rw_timeout', '5000000',
      '-i', `rtmp://127.0.0.1:${cfg.rtmpPort}/${cfg.rtmpApp}/${channel.name}`,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy',
      '-f', 'hls',
      '-hls_time', String(cfg.hlsTime),
      '-hls_list_size', String(cfg.hlsListSize),
      // 只用最通用的 HLS 参数，兼容服务器上较旧的 ffmpeg；断流时播放列表会被看门狗删除
      '-hls_flags', 'delete_segments',
      '-hls_segment_filename', path.join(channel.dir, 'segment_%06d.ts'),
      channel.playlist,
    ];

    const proc = spawn(cfg.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    channel.process = proc;
    channel.lastError = '';

    proc.stderr.on('data', (chunk) => {
      channel.lastError = (channel.lastError + chunk.toString('utf8')).slice(-1000);
    });
    proc.on('error', (err) => {
      this.log(`ffmpeg 启动失败 (${channel.name}): ${err.message}`);
    });
    proc.on('close', (code) => {
      if (channel.process !== proc) return;
      channel.process = null;
      channel.ready = false;
      this.scheduleRetry(channel, `ffmpeg 退出码 ${code}`);
    });

    clearInterval(channel.readyTimer);
    channel.readyTimer = setInterval(() => {
      if (!channel.process) return;
      let mtime = 0;
      try {
        mtime = fs.statSync(channel.playlist).mtimeMs;
      } catch (_err) {
        // 播放列表尚未生成
      }
      if (mtime && mtime !== channel.lastMtime) {
        channel.lastMtime = mtime;
        channel.lastOutputAt = Date.now();
        channel.ready = true;
        channel.failures = 0;
        channel.retryDeadline = 0;
        return;
      }
      const idleSince = channel.lastOutputAt || channel.processStartedAt;
      const limit = channel.lastOutputAt ? this.staleMs : (channel.failures > 0 ? 4000 : this.startupMs);
      if (Date.now() - idleSince > limit) {
        this.log(`频道 ${channel.name} ${channel.lastOutputAt ? '分片停止更新' : '未收到推流数据'}，重启转封装`);
        if (channel.lastOutputAt && this.onSignalLost) this.onSignalLost(channel);
        channel.ready = false;
        this.kill(channel);
        channel.process = null;
        this.scheduleRetry(channel, '播放列表超时');
      }
    }, 500);
    channel.readyTimer.unref();
  }

  scheduleRetry(channel, reason) {
    if (channel.stopped || this.channels.get(channel.name) !== channel) return;
    channel.failures += 1;
    if (!channel.retryDeadline) channel.retryDeadline = Date.now() + 15000;
    if (channel.failures <= MAX_RETRIES && Date.now() < channel.retryDeadline) {
      // 前几次快速重试（应对推流刚建立时的竞态），之后放慢频率等待 OBS 恢复
      const delay = channel.failures <= 6 ? 600 : 2000;
      clearTimeout(channel.retryTimer);
      channel.retryTimer = setTimeout(() => this.launch(channel), delay);
    } else {
      const detail = channel.lastError.trim().split('\n').slice(-2).join(' ');
      this.log(`频道 ${channel.name} 已离线（${reason}），等待 OBS 重新推流。${detail}`);
      this.stop(channel.name);
    }
  }

  stop(name) {
    const channel = this.channels.get(name);
    if (!channel || channel.stopped) return;

    this.log(`频道离线: ${name}`);
    channel.online = false;
    channel.stopped = true;
    channel.ready = false;
    this.clearTimers(channel);
    this.kill(channel);
    channel.process = null;

    channel.cleanupTimer = setTimeout(() => {
      if (this.channels.get(name) === channel && channel.stopped) {
        this.channels.delete(name);
        fs.rm(channel.dir, { recursive: true, force: true }, () => {});
      }
    }, 8000);
    channel.cleanupTimer.unref();
  }

  stopAll() {
    for (const channel of this.channels.values()) {
      this.clearTimers(channel);
      channel.stopped = true;
      channel.ready = false;
      this.kill(channel);
      channel.process = null;
    }
    this.channels.clear();
  }

  kill(channel) {
    if (!channel.process) return;
    const proc = channel.process;
    proc.kill('SIGTERM');
    const killer = setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }, 2000);
    killer.unref();
  }

  clearTimers(channel) {
    clearTimeout(channel.retryTimer);
    clearTimeout(channel.cleanupTimer);
    clearInterval(channel.readyTimer);
    channel.retryTimer = null;
    channel.cleanupTimer = null;
    channel.readyTimer = null;
  }

  list() {
    return [...this.channels.values()]
      .filter((channel) => channel.online)
      .map((channel) => {
        const session = channel.session || {};
        return {
          name: channel.name,
          status: channel.ready ? 'live' : 'buffering',
          startedAt: channel.startedAt,
          width: session.videoWidth || 0,
          height: session.videoHeight || 0,
          fps: Math.round(session.videoFramerate || 0),
          playlist: channel.ready ? `/hls/${channel.name}/index.m3u8` : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

module.exports = StreamManager;
