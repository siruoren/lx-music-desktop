/**
 * sync-favorites —— 通过 WebDAV / FTP 同步「我的列表」（试听列表 + 我的收藏 + 创建的歌单）。
 *
 * 功能：
 *   1. 备份（上传）：把客户端「我的列表」导出为 JSON，加密后（可选）上传到 WebDAV 或 FTP。
 *      同步范围可配：default=试听列表 / love=我的收藏 / user=我的列表(创建的歌单)，默认三类全同步。
 *   2. 还原（下载）：从远端拉取备份文件，解密（若加密）后写回客户端「我的列表」。
 *   3. 增量同步 + 冲突合并：以「上次同步基线」做三路合并，仅传输/写回真正变化的部分；
 *      当本地与远端都改了同一列表时，按「冲突策略」合并（并集，不丢歌）或以本地/远端覆盖。
 *   4. 定时同步：可设置「同步方向 + 间隔分钟」，到点在后台自动执行。
 *
 * 网络实现：纯 Node 内置模块（http/https/net/tls/crypto/url），零第三方依赖，
 * 因此插件产物仍是单个 .lxplugin 文件，不需要任何 node_modules。
 *
 * 收藏数据的读取/写回：经由宿主在 window.lx.plugins.listData 上提供的桥
 * （src/plugins/renderer.ts 的 listDataBridge），渲染端收藏存于 SQLite，
 * 必须走 store action，无法直接读文件。
 *
 * 入口以 CommonJS 导出：
 *   module.exports = { setup, uninstall, onConfigChange, onSettingsAction }
 */
'use strict'

const http = require('http')
const https = require('https')
const net = require('net')
const tls = require('tls')
const crypto = require('crypto')
const { URL } = require('url')

/** 默认配置（全部可在「设置 → 插件管理 → sync-favorites → 设置」中修改） */
const DEFAULT_CONFIG = {
  /** 同步协议：webdav / ftp */
  type: 'webdav',
  /** 服务器地址（WebDAV 含协议，如 https://dav.example.com；FTP 仅主机名） */
  host: '',
  /** 端口（留空用默认：WebDAV 取决于协议，FTP 默认 21） */
  port: '',
  /** 远端目录（不含文件名），如 lx-music/favorites */
  remotePath: 'lx-music/favorites',
  /** 备份文件名 */
  filename: 'lx_favorites.json',
  /** 账号（留空表示匿名/无认证） */
  username: '',
  /** 密码 */
  password: '',
  /** WebDAV：忽略 TLS 证书校验（自签名证书时开启） */
  insecure: false,
  /** FTP：启用 FTPS（AUTH TLS 显式加密） */
  secure: false,
  /** FTP：被动模式（绝大多数服务器需要开启） */
  passive: true,
  /** 请求超时（毫秒） */
  timeout: 20000,
  /** 同步方向：upload=备份 / download=还原 / both=双向合并 */
  mode: 'upload',
  /** 冲突策略：merge=合并双方 / local=以本地覆盖 / remote=以远端覆盖 */
  conflictStrategy: 'merge',
  /** 同步范围（逗号分隔）：default=试听列表 / love=我的收藏 / user=我的列表(歌单)；留空或 all=全部 */
  scope: 'default,love,user',
  /** 启用定时同步 */
  autoSync: false,
  /** 同步间隔（分钟，≥1） */
  interval: 60,
  /** 加密备份文件（AES-256-CBC） */
  encrypt: false,
  /** 加密密码（还原时需一致） */
  encryptPassword: '',
  /** 上次执行结果（UI 状态，持久化） */
  lastResult: '',
  /** 上次成功同步时间戳 */
  lastSyncAt: 0,
}

/** setup 时写入，供 module 上的生命周期回调使用 */
let ctx = null

/** ============================ 小工具 ============================ */

function formatTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 拼接 URL（处理多余斜杠） */
function buildRemoteUrl(cfg) {
  const base = String(cfg.host || '').replace(/\/+$/, '')
  const path = String(cfg.remotePath || '').replace(/^\/+|\/+$/g, '')
  const file = String(cfg.filename || 'lx_favorites.json').replace(/^\/+/, '')
  let url = base
  if (path) url += '/' + path
  url += '/' + file
  return url
}

/** ============================ 加密（可选） ============================ */

function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, 32) // AES-256 需要 32 字节密钥
}

function encryptText(plain, password) {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(16)
  const key = deriveKey(password, salt)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  const enc = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()])
  return { salt: salt.toString('base64'), iv: iv.toString('base64'), cipher: enc.toString('base64') }
}

function decryptText(obj, password) {
  const salt = Buffer.from(obj._salt, 'base64')
  const iv = Buffer.from(obj._iv, 'base64')
  const enc = Buffer.from(obj._cipher, 'base64')
  const key = deriveKey(password, salt)
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

/** 把收藏列表包装成传输信封（可选加密） */
function buildEnvelope(lists, cfg) {
  const meta = {
    _app: 'lx-music-desktop',
    _plugin: 'sync-favorites',
    _type: 'favorites',
    _format: 1,
    _createdAt: Date.now(),
  }
  if (cfg.encrypt && cfg.encryptPassword) {
    const e = encryptText(JSON.stringify(lists), cfg.encryptPassword)
    return Object.assign({}, meta, {
      _encrypted: true,
      _enc: 'aes-256-cbc',
      _salt: e.salt,
      _iv: e.iv,
      _cipher: e.cipher,
    })
  }
  return Object.assign({}, meta, { _encrypted: false, lists })
}

/** 解析远端文件内容为收藏列表（自动处理加密） */
function parseEnvelope(text, cfg) {
  const obj = JSON.parse(text)
  if (obj._type !== 'favorites') throw new Error('远端文件不是收藏备份（_type 不匹配）')
  if (obj._encrypted) {
    if (!cfg.encryptPassword) throw new Error('该备份已加密，请在设置中填写加密密码')
    obj.lists = JSON.parse(decryptText(obj, cfg.encryptPassword))
  }
  if (!Array.isArray(obj.lists)) throw new Error('备份内容缺少 lists 字段')
  return obj.lists
}

/** ============================ WebDAV 客户端 ============================ */

/** 发起一次 HTTP/HTTPS 请求（跟随重定向由调用方处理） */
function makeRequest(urlStr, options) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(urlStr)
    } catch (e) {
      return reject(new Error('URL 不合法：' + urlStr))
    }
    const mod = url.protocol === 'https:' ? https : http
    const headers = Object.assign({}, options.headers)
    if (options.auth && options.auth.user !== undefined) {
      headers['Authorization'] = 'Basic ' + Buffer.from(options.auth.user + ':' + options.auth.pass).toString('base64')
    }
    const reqOpts = {
      method: options.method || 'GET',
      headers,
      timeout: options.timeout || 20000,
    }
    // 仅当显式 insecure 时关闭证书校验
    if (options.secure === false) reqOpts.rejectUnauthorized = false

    const req = mod.request(url, reqOpts, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          body: Buffer.concat(chunks),
        })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('WebDAV 请求超时')))
    if (options.body) req.write(options.body)
    req.end()
  })
}

/** 逐级 MKCOL 创建远端父目录 */
async function ensureParentDirs(fileUrl, auth, insecure, timeout) {
  const u = new URL(fileUrl)
  const segs = u.pathname.split('/').filter(Boolean)
  segs.pop() // 去掉文件名
  let acc = u.origin
  for (const s of segs) {
    acc += '/' + s
    // 201 创建 / 405 已存在 / 207 多状态 → 均可忽略
    await makeRequest(acc + '/', { method: 'MKCOL', auth, secure: insecure ? false : undefined, timeout })
      .catch(() => { /* 目录已存在或父级约束，逐级推进即可 */ })
  }
}

function createWebDavClient(cfg) {
  const auth = (cfg.username || cfg.password)
    ? { user: cfg.username || '', pass: cfg.password || '' }
    : null
  const insecure = cfg.insecure === true
  const timeout = parseInt(cfg.timeout, 10) || 20000

  return {
    protocol: 'webdav',
    async putFile(url, content) {
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
      const res = await makeRequest(url, {
        method: 'PUT',
        body: buf,
        headers: { 'Content-Type': 'application/octet-stream' },
        auth, secure: insecure ? false : undefined, timeout,
      })
      if (res.status >= 400) throw new Error('WebDAV 上传失败：HTTP ' + res.status)
      return res
    },
    async getFile(url) {
      const res = await makeRequest(url, { method: 'GET', auth, secure: insecure ? false : undefined, timeout })
      if (res.status === 404) throw new Error('远端文件不存在（HTTP 404）')
      if (res.status >= 400) throw new Error('WebDAV 下载失败：HTTP ' + res.status)
      return res.body.toString('utf8')
    },
    async ensureParent(fileUrl) {
      await ensureParentDirs(fileUrl, auth, insecure, timeout)
    },
    async remove(url) {
      await makeRequest(url, { method: 'DELETE', auth, secure: insecure ? false : undefined, timeout })
        .catch(() => {})
    },
  }
}

/** ============================ FTP 客户端 ============================ */

class FtpClient {
  constructor(cfg) {
    this.host = cfg.host
    this.port = parseInt(cfg.port, 10) || 21
    this.user = cfg.username || 'anonymous'
    this.pass = cfg.password || ''
    this.secure = cfg.secure === true
    this.passive = cfg.passive !== false
    this.timeout = parseInt(cfg.timeout, 10) || 20000
    this.rejectUnauthorized = cfg.insecure !== true
    this.ctrl = null
    this._reader = null
    this._buf = ''
    this._pending = null
    this._mlCode = null
    this._mlLines = []
  }

  _onData(chunk) {
    this._buf += chunk.toString('utf8')
    let idx
    while ((idx = this._buf.indexOf('\r\n')) !== -1) {
      const line = this._buf.slice(0, idx)
      this._buf = this._buf.slice(idx + 2)
      const m = /^(\d{3})([ -])(.*)$/.exec(line)
      if (!m) continue
      const code = m[1]
      const cont = m[2]
      const text = m[3]
      if (cont === ' ') {
        const full = this._mlCode ? this._mlLines.concat(text).join('\n') : text
        this._mlCode = null
        this._mlLines = []
        if (this._pending) {
          const p = this._pending
          this._pending = null
          p.resolve({ code, message: full })
        }
      } else {
        if (!this._mlCode) {
          this._mlCode = code
          this._mlLines = []
        }
        this._mlLines.push(text)
      }
    }
  }

  _attach(sock) {
    if (this._reader && this.ctrl) {
      try { this.ctrl.removeListener('data', this._reader) } catch (e) { /* noop */ }
    }
    this._reader = c => this._onData(c)
    sock.on('data', this._reader)
    this.ctrl = sock
  }

  _cmd(cmd, ms) {
    ms = ms || this.timeout
    return new Promise((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (!done) {
          done = true
          this._pending = null
          reject(new Error('FTP 命令超时：' + cmd))
        }
      }, ms)
      const p = {
        resolve: v => { if (done) return; done = true; clearTimeout(timer); resolve(v) },
        reject: e => { if (done) return; done = true; clearTimeout(timer); reject(e) },
      }
      this._pending = p
      try {
        this.ctrl.write(cmd + '\r\n')
      } catch (e) {
        done = true
        clearTimeout(timer)
        reject(e)
      }
    })
  }

  _waitFinal() {
    return new Promise((resolve, reject) => { this._pending = { resolve, reject } })
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.host, port: this.port })
      this._buf = ''
      this._mlCode = null
      this._mlLines = []
      this._pending = null
      this._attach(sock)
      sock.once('error', e => {
        if (this._pending) { this._pending.reject(e); this._pending = null }
        reject(e)
      })
      // 首个 220 问候到达后触发登录流程
      this._pending = {
        resolve: () => { this._login().then(() => resolve()).catch(reject) },
        reject,
      }
    })
  }

  async _login() {
    if (this.secure) {
      const r = await this._cmd('AUTH TLS')
      if (r.code !== '234') throw new Error('服务器不支持 FTPS（AUTH TLS）：' + r.message)
      const oldSock = this.ctrl
      const tlsSock = await new Promise((res, rej) => {
        const t = tls.connect({ socket: oldSock, rejectUnauthorized: this.rejectUnauthorized }, () => res(t))
        t.on('error', rej)
      })
      this._attach(tlsSock) // 把控制连接读处理器切到 TLS 套接字
    }
    const u = await this._cmd('USER ' + this.user)
    if (u.code !== '230' && u.code !== '331') throw new Error('FTP 用户名错误：' + u.message)
    const p = await this._cmd('PASS ' + this.pass)
    if (p.code !== '230') throw new Error('FTP 密码错误：' + p.message)
    if (this.secure) {
      await this._cmd('PBSZ 0').catch(() => {})
      await this._cmd('PROT P').catch(() => {})
    }
    await this._cmd('TYPE I').catch(() => {}) // 二进制模式
  }

  /** 被动模式：打开数据连接 */
  async _openData() {
    const r = await this._cmd('PASV')
    if (r.code !== '227') throw new Error('PASV 失败：' + r.message)
    const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(r.message)
    if (!m) throw new Error('无法解析 PASV 响应：' + r.message)
    const ip = [m[1], m[2], m[3], m[4]].join('.')
    const port = (parseInt(m[5], 10) << 8) | parseInt(m[6], 10)
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: ip, port })
      if (this.secure) {
        const t = tls.connect({ socket: sock, rejectUnauthorized: this.rejectUnauthorized }, () => resolve(t))
        t.on('error', reject)
      } else {
        sock.once('connect', () => resolve(sock))
        sock.once('error', reject)
      }
    })
  }

  async putFile(remotePath, content) {
    const self = this
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const data = await this._openData()
    const prep = await this._cmd('STOR ' + remotePath)
    if (prep.code !== '150' && prep.code !== '125') {
      try { data.destroy() } catch (e) { /* noop */ }
      throw new Error('FTP STOR 准备失败：' + prep.message)
    }
    const done226 = this._waitFinal()
    await new Promise((resolve, reject) => {
      data.on('error', reject)
      data.on('close', resolve)
      data.write(buf)
      data.end()
    })
    const fin = await done226
    if (fin.code !== '226' && fin.code !== '250') throw new Error('FTP 上传完成状态异常：' + fin.message)
    return fin
  }

  async getFile(remotePath) {
    const data = await this._openData()
    const prep = await this._cmd('RETR ' + remotePath)
    if (prep.code === '550' || prep.code === '450' || prep.code === '500') {
      try { data.destroy() } catch (e) { /* noop */ }
      throw new Error('远端文件不存在或无权限')
    }
    if (prep.code !== '150' && prep.code !== '125') {
      try { data.destroy() } catch (e) { /* noop */ }
      throw new Error('FTP RETR 准备失败：' + prep.message)
    }
    const done226 = this._waitFinal()
    const chunks = []
    await new Promise((resolve, reject) => {
      data.on('data', c => chunks.push(c))
      data.on('error', reject)
      data.on('close', resolve)
    })
    await done226
    return Buffer.concat(chunks).toString('utf8')
  }

  /** 逐级创建远端父目录 */
  async ensureDir(remotePath) {
    const parts = remotePath.split('/').filter(Boolean)
    parts.pop() // 去掉文件名
    let cur = ''
    for (const part of parts) {
      cur += '/' + part
      const c = await this._cmd('CWD ' + cur).catch(() => ({ code: '550' }))
      if (c.code === '250') continue
      const mk = await this._cmd('MKD ' + cur).catch(() => ({ code: '550' }))
      if (mk.code !== '257' && mk.code !== '250') {
        const c2 = await this._cmd('CWD ' + cur).catch(() => ({ code: '550' }))
        if (c2.code !== '250') throw new Error('FTP 创建目录失败：' + cur + '（' + mk.message + '）')
      }
    }
  }

  async remove(remotePath) {
    await this._cmd('DELE ' + remotePath).catch(() => { /* 不存在则忽略 */ })
  }

  close() {
    try { this._cmd('QUIT').catch(() => {}) } catch (e) { /* noop */ }
    try { if (this.ctrl) this.ctrl.destroy() } catch (e) { /* noop */ }
  }
}

function createFtpClient(cfg) {
  const client = new FtpClient(cfg)
  return {
    protocol: 'ftp',
    _client: client,
    async putFile(remotePath, content) {
      await client.connect()
      try {
        await client.ensureDir(remotePath)
        return await client.putFile(remotePath, content)
      } finally {
        client.close()
      }
    },
    async getFile(remotePath) {
      await client.connect()
      try {
        return await client.getFile(remotePath)
      } finally {
        client.close()
      }
    },
    async ensureParent(remotePath) {
      await client.connect()
      try {
        await client.ensureDir(remotePath)
      } finally {
        client.close()
      }
    },
    async remove(remotePath) {
      await client.connect()
      try {
        await client.remove(remotePath)
      } finally {
        client.close()
      }
    },
  }
}

/** ============================ 客户端工厂 + 同步逻辑 ============================ */

function buildClient(cfg) {
  const type = String(cfg.type || 'webdav').toLowerCase()
  if (type === 'ftp') return createFtpClient(cfg)
  return createWebDavClient(cfg)
}

/** ============================ 增量同步 + 冲突合并 ============================ */

/** 列表 id 归属类别：default/love 是固定 id，其余均为 user（我的列表/歌单） */
function categoryOf(id) {
  if (id === 'default') return 'default'
  if (id === 'love') return 'love'
  return 'user'
}

/** 解析 scope 为 { default, love, user } 三个布尔（默认全 true） */
function normalizeScope(scope) {
  if (scope == null || scope === '') return { default: true, love: true, user: true }
  if (typeof scope === 'string') {
    const s = String(scope).trim()
    if (s === '' || s === 'all') return { default: true, love: true, user: true }
    const parts = s.split(',').map(x => x.trim())
    return { default: parts.includes('default'), love: parts.includes('love'), user: parts.includes('user') }
  }
  if (typeof scope === 'object' && scope !== null) {
    return { default: scope.default !== false, love: scope.love !== false, user: scope.user !== false }
  }
  return { default: true, love: true, user: true }
}

/** 按 scope 过滤归一化集合（丢弃未选中类别的列表，避免污染合并与基线） */
function filterByScope(norm, scope) {
  const want = normalizeScope(scope)
  const map = {}
  const order = []
  const ids = norm.order.concat(Object.keys(norm.map).filter(id => !norm.order.includes(id)))
  for (const id of ids) {
    if (!want[categoryOf(id)]) continue
    map[id] = norm.map[id]
    if (!order.includes(id)) order.push(id)
  }
  return { map, order }
}

/** 按 scope 过滤基线（{ id -> { name, songs } }） */
function filterBaseByScope(base, scope) {
  if (!base || typeof base !== 'object') return {}
  const want = normalizeScope(scope)
  const out = {}
  for (const id of Object.keys(base)) {
    if (want[categoryOf(id)]) out[id] = base[id]
  }
  return out
}

/** 歌曲去重键：优先用 id（lx-music 为 source_musicId），其次退化为 source:musicId；字符串原样返回（基线里存的是 id） */
function songKey(song) {
  if (typeof song === 'string') return song
  if (!song || typeof song !== 'object') return ''
  if (song.id != null && song.id !== '') return String(song.id)
  return `${song.source || ''}:${song.musicId != null ? song.musicId : ''}`
}

/** 把列表数组规整为 { id -> { id, name, songs:[obj] } }（保留顺序，便于增量比对） */
function normalizeCollection(lists) {
  const map = {}
  const order = []
  const arr = Array.isArray(lists) ? lists : []
  for (const l of arr) {
    if (!l || l.id == null) continue
    const id = String(l.id)
    map[id] = { id, name: l.name, songs: Array.isArray(l.list) ? l.list.slice() : [] }
    if (!order.includes(id)) order.push(id)
  }
  return { map, order }
}

/** 还原为导入/导出用的列表数组（id + name + list） */
function denormalizeCollection(norm) {
  const { map, order } = norm
  const ids = order.slice()
  for (const id of Object.keys(map)) if (!ids.includes(id)) ids.push(id)
  return ids.map(id => ({ id, name: map[id].name, list: map[id].songs.slice() }))
}

/** 比较两个列表的名称与歌曲集合（忽略顺序）是否一致 */
function sameList(a, b) {
  if (!a || !b) return false
  if (a.name !== b.name) return false
  const ax = new Set(a.songs.map(songKey))
  const bx = new Set(b.songs.map(songKey))
  if (ax.size !== bx.size) return false
  for (const k of ax) if (!bx.has(k)) return false
  return true
}

/** 并集两个列表的歌曲（按 key 去重，本地在前、远端新增在后） */
function mergeListSongs(l, r) {
  const seen = new Set()
  const out = []
  const push = (s) => { const k = songKey(s); if (k && !seen.has(k)) { seen.add(k); out.push(s) } }
  for (const s of (l.songs || [])) push(s)
  for (const s of (r.songs || [])) push(s)
  return out
}

/**
 * 三路合并：base=上次同步的共同基线，local=本地现状，remote=远端现状。
 * @param strategy 'merge' 并集(不丢歌) / 'local' 冲突以本地为准 / 'remote' 冲突以远端为准
 * @returns { collection:{id->list}, order:[id], conflicts:[{id,name,strategy}] }
 */
function mergeCollections(base, local, remote, strategy) {
  const normBase = base || {}
  const ids = new Set([
    ...Object.keys(normBase),
    ...Object.keys(local),
    ...Object.keys(remote),
  ])
  const collection = {}
  const conflicts = []
  const order = []
  for (const id of ids) {
    const b = normBase[id]
    const l = local[id]
    const r = remote[id]
    let chosen
    let conflicted = false
    if (l == null) {
      chosen = { id, name: r.name, songs: r.songs.slice() }
    } else if (r == null) {
      chosen = { id, name: l.name, songs: l.songs.slice() }
    } else {
      const lChanged = !sameList(l, b)
      const rChanged = !sameList(r, b)
      if (!lChanged && !rChanged) {
        chosen = { id, name: l.name, songs: l.songs.slice() }
      } else if (lChanged && !rChanged) {
        chosen = { id, name: l.name, songs: l.songs.slice() }
      } else if (!lChanged && rChanged) {
        chosen = { id, name: r.name, songs: r.songs.slice() }
      } else {
        conflicted = true
        if (strategy === 'local') {
          chosen = { id, name: l.name, songs: l.songs.slice() }
        } else if (strategy === 'remote') {
          chosen = { id, name: r.name, songs: r.songs.slice() }
        } else {
          chosen = { id, name: l.name || r.name, songs: mergeListSongs(l, r) }
        }
      }
    }
    collection[id] = chosen
    if (!order.includes(id)) order.push(id)
    if (conflicted) conflicts.push({ id, name: chosen.name || id, strategy })
  }
  return { collection, order, conflicts }
}

/** 集合相等（用于增量判断：内容无变化则跳过传输/写回，避免无谓覆盖） */
function collectionsEqual(aMap, bMap) {
  const ak = Object.keys(aMap)
  const bk = Object.keys(bMap)
  if (ak.length !== bk.length) return false
  for (const id of ak) {
    if (!bMap[id]) return false
    if (!sameList(aMap[id], bMap[id])) return false
  }
  return true
}

/** 读取上次同步基线（本地持久化的「共同祖先」，仅存 id 集合，省空间） */
function readSyncBase(api) {
  try {
    const b = api.getData('syncBase', null)
    if (b && b.lists && typeof b.lists === 'object') return b.lists
  } catch (e) { /* noop */ }
  return null
}

/** 写入上次同步基线（只存歌曲 id 集合 + 列表名，节省空间） */
function writeSyncBase(api, merged) {
  const lists = {}
  for (const id of Object.keys(merged.collection)) {
    const l = merged.collection[id]
    lists[id] = { name: l.name, songs: l.songs.map(songKey) }
  }
  try { api.setData('syncBase', { schema: 1, lists, at: Date.now() }) } catch (e) { /* noop */ }
}

/** 真正执行一次同步（direction: upload / download / both） */
async function doSync(api, cfg, direction) {
  if (!api.app || !api.app.plugins || !api.app.plugins.listData) {
    throw new Error('宿主未提供收藏数据桥（listData），请升级到含插件系统的客户端版本')
  }
  const bridge = api.app.plugins.listData
  const client = buildClient(cfg)
  const fileUrl = buildRemoteUrl(cfg)
  const strategy = cfg.conflictStrategy || 'merge'

  // 1) 取本地现状（按 scope 过滤）
  const localNorm = normalizeCollection(await bridge.exportAll(cfg.scope))

  // 2) 取远端现状（不存在/解析失败 → 视为首次同步，远端为空）；并按 scope 过滤，避免未选类别串味
  let remoteNorm = { map: {}, order: [] }
  try {
    const text = await client.getFile(fileUrl)
    remoteNorm = filterByScope(normalizeCollection(parseEnvelope(text, cfg)), cfg.scope)
  } catch (e) {
    api.logger.warn('sync-favorites 远端暂无可同步文件，按首次同步处理：', e.message)
  }

  // 3) 取上次同步基线（共同祖先），并按 scope 过滤，避免切换范围后基线串味
  const base = readSyncBase(api)
  const baseFiltered = filterBaseByScope(base, cfg.scope)
  const baseNorm = base ? { map: baseFiltered, order: Object.keys(baseFiltered) } : { map: {}, order: [] }

  // 4) 三路合并（只涉及 scope 内的列表）
  const merged = mergeCollections(baseNorm.map, localNorm.map, remoteNorm.map, strategy)

  // 5) 按方向写入（内容无变化则跳过，即「增量」：不重复传输/覆盖）
  const writeRemote = direction === 'upload' || direction === 'both'
  const writeLocal = direction === 'download' || direction === 'both'
  const msgs = []
  let wrote = false

  if (writeRemote && !collectionsEqual(merged.collection, remoteNorm.map)) {
    const payload = buildEnvelope(denormalizeCollection(merged), cfg)
    await client.ensureParent(fileUrl)
    await client.putFile(fileUrl, payload)
    msgs.push('已上传 ' + Object.keys(merged.collection).length + ' 个列表')
    wrote = true
  }
  if (writeLocal && !collectionsEqual(merged.collection, localNorm.map)) {
    await bridge.importAll(denormalizeCollection(merged), cfg.scope)
    msgs.push('已写回本地 ' + Object.keys(merged.collection).length + ' 个列表')
    wrote = true
  }

  // 6) 无论是否落盘，都更新基线（下一次同步的共同祖先）
  writeSyncBase(api, merged)

  if (merged.conflicts.length) {
    const verb = strategy === 'local' ? '以本地覆盖' : strategy === 'remote' ? '以远端覆盖' : '合并双方'
    msgs.push(`解决 ${merged.conflicts.length} 个冲突列表（${verb}）`)
  }
  if (!wrote) msgs.push('两侧无变化，已跳过传输')

  return msgs.join('；')
}

/** 连接测试：在目标目录放一个临时文件并回读，再删除 */
async function testConnection(api, cfg) {
  const client = buildClient(cfg)
  const fileUrl = buildRemoteUrl(cfg)
  const parent = fileUrl.replace(/[^/]+$/, '')
  const tmpUrl = parent + '.lx_sync_test_' + Date.now()
  const probe = JSON.stringify({ _test: true, _t: Date.now() })
  await client.ensureParent(fileUrl)
  await client.putFile(tmpUrl, probe)
  const back = await client.getFile(tmpUrl)
  let ok = false
  try { ok = JSON.parse(back)._t != null } catch (e) { /* noop */ }
  if (!ok) throw new Error('回读内容与写入不一致')
  await client.remove(tmpUrl)
  return '连接正常，读写均成功'
}

/** ============================ 插件生命周期 ============================ */

module.exports = {
  // —— 以下纯函数供自测（宿主只调用 setup/onConfigChange/onSettingsAction/uninstall）——
  _internals: {
    songKey,
    normalizeCollection,
    denormalizeCollection,
    sameList,
    mergeCollections,
    collectionsEqual,
    readSyncBase,
    writeSyncBase,
    categoryOf,
    normalizeScope,
    filterByScope,
    filterBaseByScope,
  },
  setup(api) {
    const state = Object.assign({}, DEFAULT_CONFIG, api.getConfig())
    let timer = null

    const persist = (patch) => { api.setConfig(patch) }

    const startTimer = () => {
      stopTimer()
      const minutes = Math.max(1, parseInt(state.interval, 10) || 1)
      timer = setInterval(() => {
        void execute('timer').catch(e => api.logger.error('sync-favorites 定时同步异常：', e))
      }, minutes * 60000)
    }
    const stopTimer = () => {
      if (timer) { clearInterval(timer); timer = null }
    }

    /** 统一执行入口：direction = upload/download/test/timer(用 state.mode) */
    const execute = async(direction) => {
      const dir = direction === 'timer' ? (state.mode || 'upload') : direction
      const label = dir === 'test' ? '连接测试' : dir === 'download' ? '还原' : dir === 'upload' ? '备份' : '同步'
      try {
        let msg
        if (dir === 'test') msg = await testConnection(api, state)
        else msg = await doSync(api, state, dir)
        state.lastResult = `${label}成功（${formatTime(Date.now())}）：${msg}`
        if (dir !== 'test') state.lastSyncAt = Date.now()
      } catch (e) {
        state.lastResult = `${label}失败（${formatTime(Date.now())}）：${e.message}`
        api.logger.error('sync-favorites 执行失败：', e)
      } finally {
        persist({ lastResult: state.lastResult, lastSyncAt: state.lastSyncAt })
      }
    }

    ctx = { api, state, startTimer, stopTimer, execute }

    /* ---------- 声明式设置面板 ---------- */
    if (api.registerSettings) {
      api.registerSettings({
        title: '我的列表同步',
        fields: [
          {
            type: 'text',
            key: 'type',
            label: '同步协议',
            default: 'webdav',
            placeholder: 'webdav 或 ftp',
            tip: 'webdav：基于 HTTP 的网盘/同步盘；ftp：文件传输协议（可勾选 FTPS 加密）。',
          },
          { type: 'text', key: 'host', label: '服务器地址', placeholder: 'https://dav.example.com 或 ftp.example.com', default: '' },
          { type: 'text', key: 'port', label: '端口', placeholder: 'WebDAV 依协议默认；FTP 默认 21', default: '', tip: '留空使用协议默认端口。' },
          { type: 'text', key: 'remotePath', label: '远端目录', placeholder: 'lx-music/favorites', default: 'lx-music/favorites' },
          { type: 'text', key: 'filename', label: '文件名', placeholder: 'lx_favorites.json', default: 'lx_favorites.json' },
          { type: 'text', key: 'username', label: '账号', placeholder: '留空表示匿名/无认证', default: '' },
          { type: 'password', key: 'password', label: '密码', placeholder: '留空表示不需要密码', default: '' },
          { type: 'switch', key: 'insecure', label: 'WebDAV 忽略证书校验（自签名）', default: false },
          { type: 'switch', key: 'secure', label: 'FTP 启用 FTPS（AUTH TLS 加密）', default: false },
          { type: 'switch', key: 'passive', label: 'FTP 被动模式', default: true, tip: '绝大多数 FTP 服务器需要开启；如遇连接超时再尝试关闭。' },
          { type: 'number', key: 'timeout', label: '超时（毫秒）', default: 20000 },
          { type: 'divider' },
          {
            type: 'text',
            key: 'mode',
            label: '同步方向',
            default: 'upload',
            placeholder: 'upload / download / both',
            tip: 'upload=备份到远端；download=从远端还原到本地；both=双向合并（推荐）。双向/还原时若本地与远端都有改动，按下方「冲突策略」处理；内容无变化则跳过传输（增量）。',
          },
          {
            type: 'text',
            key: 'conflictStrategy',
            label: '冲突策略',
            default: 'merge',
            placeholder: 'merge / local / remote',
            tip: '本地与远端都改了同一列表时如何处理：merge=合并双方（并集，不丢歌）；local=以本地为准覆盖远端；remote=以远端为准覆盖本地。',
          },
          {
            type: 'text',
            key: 'scope',
            label: '同步范围',
            default: 'default,love,user',
            placeholder: 'default,love,user 或 all',
            tip: '逗号分隔，控制同步哪些列表：default=试听列表、love=我的收藏、user=我的列表（创建的歌单）；留空或 all=全部同步。试听列表是临时播放队列，跨设备同步通常意义不大，可去掉 default 只写 love,user。',
          },
          { type: 'switch', key: 'autoSync', label: '启用定时同步', default: false },
          { type: 'number', key: 'interval', label: '同步间隔（分钟）', default: 60, tip: '≥1；仅在「启用定时同步」后生效。' },
          { type: 'divider' },
          { type: 'switch', key: 'encrypt', label: '加密备份文件（AES-256）', default: false, tip: '加密后即使云端泄露也无法读取收藏内容；还原需填写相同密码。' },
          { type: 'password', key: 'encryptPassword', label: '加密密码', placeholder: '还原时需一致', default: '' },
          { type: 'divider' },
          {
            type: 'buttons',
            buttons: [
              { label: '立即备份', action: 'backup' },
              { label: '立即还原', action: 'restore' },
              { label: '测试连接', action: 'test' },
            ],
          },
          {
            type: 'info',
            label: '状态',
            text: () => state.lastResult || '尚未执行',
            suffix: () => (state.lastSyncAt ? `上次同步：${formatTime(state.lastSyncAt)}` : '从未同步'),
          },
        ],
      })
    }

    api.hooks.on('app:ready', () => {
      api.logger.info(`已就绪：sync-favorites v${api.version}；协议 ${state.type}，方向 ${state.mode}`)
      if (state.autoSync && state.interval > 0) startTimer()
    })
  },

  /** 设置面板改动配置后调用：同步进内存，并按需重启定时器 */
  onConfigChange(next) {
    if (!ctx) return undefined
    const prevAuto = ctx.state.autoSync
    const prevInt = ctx.state.interval
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (key in next) ctx.state[key] = next[key]
    }
    if (ctx.state.autoSync !== prevAuto || ctx.state.interval !== prevInt) {
      if (ctx.state.autoSync && ctx.state.interval > 0) ctx.startTimer()
      else ctx.stopTimer()
    }
    return undefined
  },

  /** 设置面板按钮点击 */
  onSettingsAction(action) {
    if (!ctx) return undefined
    if (action === 'backup') return ctx.execute('upload')
    if (action === 'restore') return ctx.execute('download')
    if (action === 'test') return ctx.execute('test')
    if (action === 'sync') return ctx.execute(ctx.state.mode)
    return undefined
  },

  /** 卸载/禁用：清理定时器 */
  uninstall() {
    if (ctx) ctx.stopTimer()
    ctx = null
    console.log('[plugin:sync-favorites] 已卸载，定时器已清理')
  },
}
