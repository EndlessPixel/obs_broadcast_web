'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VALID_CHANNEL = /^[A-Za-z0-9_-]{1,48}$/;
const ONLINE_TTL = 30 * 1000;
const MESSAGE_LIMIT = 200;
const MIN_SEND_INTERVAL = 800;
const MAX_TEXT = 200;
const MAX_NAME = 16;
const HOST_TTL = 12 * 60 * 60 * 1000;
const VERIFY_WINDOW = 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

class ChatStore {
  constructor(config, log = console.log) {
    this.log = log;
    this.dir = path.join(config.dataDir, 'chat');
    this.channels = new Map();
    this.lastSent = new Map();
    this.hosts = new Map();
    this.reservedNames = new Map();
    this.verifyAttempts = new Map();
    this.reset();
  }

  // 每次服务启动都清空：消息落磁盘，但生命周期只到本次运行结束
  reset() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.channels.clear();
    this.lastSent.clear();
    this.hosts.clear();
    this.reservedNames.clear();
    this.verifyAttempts.clear();
    this.epoch = String(Date.now());
    this.log('评论区已清空（历史消息不跨重启保留）');
  }

  static validChannel(name) {
    return typeof name === 'string' && VALID_CHANNEL.test(name);
  }

  channel(name) {
    let item = this.channels.get(name);
    if (!item) {
      item = {
        name,
        file: path.join(this.dir, `${name}.jsonl`),
        seq: 0,
        messages: [],
        online: new Map(),
      };
      this.channels.set(name, item);
    }
    return item;
  }

  prune(now = Date.now()) {
    for (const item of this.channels.values()) {
      for (const [uid, entry] of item.online) {
        if (now - entry.seen > ONLINE_TTL) item.online.delete(uid);
      }
    }
    for (const [uid, ts] of this.lastSent) {
      if (now - ts > 60 * 1000) this.lastSent.delete(uid);
    }
    for (const [uid, expiry] of this.hosts) {
      if (expiry <= now) this.hosts.delete(uid);
    }
    for (const [name, entry] of this.reservedNames) {
      if (entry.expiry <= now) this.reservedNames.delete(name);
    }
    for (const [uid, entry] of this.verifyAttempts) {
      if (now - entry.at > VERIFY_WINDOW) this.verifyAttempts.delete(uid);
    }
  }

  // 主播凭据只由服务端校验，客户端无法自行声明身份
  verifyHost(uid, token, expected, username = '') {
    if (!expected) {
      return { ok: false, status: 400, error: '服务器未启用主播身份验证' };
    }
    if (!uid) {
      return { ok: false, status: 400, error: '缺少客户端标识' };
    }
    const now = Date.now();
    this.prune(now);
    let attempt = this.verifyAttempts.get(uid);
    if (!attempt || now - attempt.at > VERIFY_WINDOW) {
      attempt = { at: now, count: 0 };
      this.verifyAttempts.set(uid, attempt);
    }
    attempt.count += 1;
    if (attempt.count > MAX_VERIFY_ATTEMPTS) {
      return { ok: false, status: 429, error: '尝试次数过多，稍后再试' };
    }
    if (String(token ?? '') !== expected) {
      return { ok: false, status: 401, error: '主播口令不正确' };
    }
    this.verifyAttempts.delete(uid);
    const expiry = now + HOST_TTL;
    this.hosts.set(uid, expiry);

    // 主播当前用户名登记为保留名：同名只能由该 uid 使用
    const hostName = clean(username, MAX_NAME);
    for (const [name, entry] of this.reservedNames) {
      if (entry.uid === uid && name !== hostName.toLowerCase()) {
        this.reservedNames.delete(name);
      }
    }
    if (hostName) {
      this.reservedNames.set(hostName.toLowerCase(), { uid, expiry });
    }
    return { ok: true };
  }

  nameStatus(username, uid) {
    const name = clean(username, MAX_NAME);
    const key = name.toLowerCase();
    const entry = key ? this.reservedNames.get(key) : null;
    const reserved = Boolean(entry && entry.uid !== uid && entry.expiry > Date.now());
    return {
      reserved,
      displayName: reserved ? `游客${String(uid || '').slice(-4)}` : name,
    };
  }

  isHost(uid, now = Date.now()) {
    if (!uid) return false;
    const expiry = this.hosts.get(uid);
    if (!expiry) return false;
    if (expiry <= now) {
      this.hosts.delete(uid);
      return false;
    }
    return true;
  }

  // 轮询本身即心跳：带用户名和 uid 的拉取会计入在线
  touch(name, uid, username) {
    if (!ChatStore.validChannel(name)) return 0;
    const item = this.channel(name);
    const now = Date.now();
    this.prune(now);
    if (uid && username) {
      item.online.set(uid, { name: username, seen: now });
    }
    return item.online.size;
  }

  leave(name, uid) {
    if (!ChatStore.validChannel(name) || !uid) return;
    const item = this.channel(name);
    item.online.delete(uid);
  }

  onlineCount(name) {
    if (!ChatStore.validChannel(name)) return 0;
    this.prune();
    return this.channel(name).online.size;
  }

  messages(name, since = 0) {
    if (!ChatStore.validChannel(name)) return [];
    const item = this.channel(name);
    const from = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
    return item.messages.filter((message) => message.id > from).slice(-100);
  }

  post(name, payload) {
    if (!ChatStore.validChannel(name)) {
      return { ok: false, status: 400, error: '频道名不合法' };
    }
    const uid = clean(payload?.uid, 64);
    const username = clean(payload?.name, MAX_NAME);
    const text = clean(payload?.text, MAX_TEXT);
    if (!uid || !username || !text) {
      return { ok: false, status: 400, error: '需要用户名和消息内容' };
    }
    if (this.nameStatus(username, uid).reserved) {
      return { ok: false, status: 403, error: '该用户名已被主播占用，请换一个名字' };
    }

    const now = Date.now();
    const last = this.lastSent.get(uid) || 0;
    if (now - last < MIN_SEND_INTERVAL) {
      return { ok: false, status: 429, error: '发送太快了，稍等一下' };
    }
    this.lastSent.set(uid, now);

    // 身份完全由服务端决定，忽略客户端传来的任何 role / host 字段
    const role = this.isHost(uid, now) ? 'host' : 'viewer';
    const item = this.channel(name);
    const message = { id: ++item.seq, ts: now, user: username, text, role };
    const line = `${JSON.stringify(message)}\n`;
    try {
      fs.appendFileSync(item.file, line, 'utf8');
    } catch (err) {
      this.log(`评论写入失败 (${name}): ${err.message}`);
      return { ok: false, status: 500, error: '消息保存失败' };
    }
    item.messages.push(message);
    if (item.messages.length > MESSAGE_LIMIT) item.messages.shift();
    return { ok: true, message };
  }
}

module.exports = ChatStore;
