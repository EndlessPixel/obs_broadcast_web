'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_RECORDS = 100;
const VALID_CHANNEL = /^[A-Za-z0-9_-]{1,48}$/;

class HistoryStore {
  constructor(config, log = console.log) {
    this.log = log;
    this.file = path.join(config.dataDir, 'history.jsonl');
    this.records = [];
    this.active = new Map();
    this.sessionChannels = new Map();
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const lines = fs.readFileSync(this.file, 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines.slice(-MAX_RECORDS)) {
        try {
          const record = JSON.parse(line);
          if (record && typeof record.channel === 'string' && record.startedAt) {
            this.records.push(record);
          }
        } catch (_err) { /* 跳过损坏行 */ }
      }
      if (this.records.length) {
        this.log(`开播历史已加载 ${this.records.length} 条`);
      }
    } catch (err) {
      this.log(`开播历史读取失败: ${err.message}`);
    }
  }

  static validChannel(name) {
    return typeof name === 'string' && VALID_CHANNEL.test(name);
  }

  // 同一频道断线重连（不同 session id）合并为一条记录
  start(sessionId, channel, session) {
    if (!HistoryStore.validChannel(channel) || !sessionId) return;

    const currentChannel = this.sessionChannels.get(sessionId);
    if (currentChannel && currentChannel !== channel) {
      this.sessionChannels.delete(sessionId);
    }

    const existing = this.active.get(channel);
    if (existing) {
      if (existing.sessionId && existing.sessionId !== sessionId) {
        this.sessionChannels.delete(existing.sessionId);
      }
      existing.sessionId = sessionId;
      this.sessionChannels.set(sessionId, channel);
      return;
    }

    const record = {
      id: `${Date.now()}-${channel}`,
      channel,
      startedAt: session?.createTime || Date.now(),
      endedAt: null,
      durationMs: null,
      width: session?.videoWidth || 0,
      height: session?.videoHeight || 0,
      fps: Math.round(session?.videoFramerate || 0),
      sessionId,
    };
    this.active.set(channel, record);
    this.sessionChannels.set(sessionId, channel);
    this.log(`频道上线: ${channel}`);
  }

  end(sessionId, session) {
    const channel = this.sessionChannels.get(sessionId);
    if (!channel) return;
    this.sessionChannels.delete(sessionId);

    this.endByChannel(channel, sessionId, session);
  }

  // 断流看门狗检测到停播时立即结算，不必等 NMS 的 30 秒宽限期
  endByChannel(channel, sessionId, session) {
    const record = this.active.get(channel);
    if (!record) return;
    if (sessionId && record.sessionId && record.sessionId !== sessionId) return;
    this.active.delete(channel);
    if (record.sessionId) this.sessionChannels.delete(record.sessionId);

    record.endedAt = session?.endTime || Date.now();
    record.durationMs = Math.max(0, record.endedAt - record.startedAt);
    if (session?.videoWidth) record.width = session.videoWidth;
    if (session?.videoHeight) record.height = session.videoHeight;
    if (session?.videoFramerate) record.fps = Math.round(session.videoFramerate);
    delete record.sessionId;

    this.records.push(record);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (err) {
      this.log(`开播历史写入失败: ${err.message}`);
    }
  }

  // 进行中的记录由服务端计算时长，前端不做时间统计
  list(limit = 30) {
    const now = Date.now();
    const finished = this.records.map((record) => ({ ...record, ongoing: false }));
    const ongoing = [...this.active.values()].map((record) => ({
      id: record.id,
      channel: record.channel,
      startedAt: record.startedAt,
      endedAt: null,
      durationMs: Math.max(0, now - record.startedAt),
      width: record.width,
      height: record.height,
      fps: record.fps,
      ongoing: true,
    }));
    const all = [...ongoing, ...finished].sort((a, b) => b.startedAt - a.startedAt);
    const size = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_RECORDS) : 30;
    return all.slice(0, size);
  }
}

module.exports = HistoryStore;
