/**
 * sync-favorites —— 通过 WebDAV / FTP 同步「我的列表」（试听列表 + 我的收藏 + 创建的歌单）。
 *
 * 功能：
 *   1. 备份（上传）：把客户端「我的列表」导出为 JSON，加密后（可选）上传到 WebDAV / FTP / SMB。
 *      同步范围可配：default=试听列表 / love=我的收藏 / user=我的列表(创建的歌单)，默认三类全同步。
 *   2. 还原（下载）：从远端拉取备份文件，解密（若加密）后写回客户端「我的列表」。
 *   3. 增量同步 + 冲突合并：以「上次同步基线」做三路合并，仅传输/写回真正变化的部分；
 *      当本地与远端都改了同一列表时，按「冲突策略」合并（并集，不丢歌）或以本地/远端覆盖。
 *   4. 定时同步：可设置「同步方向 + 间隔分钟」，到点在后台自动执行。
 *   5. 目录浏览：填写协议 + 服务器地址后，点「浏览目录」（或改地址自动触发）即可列出远端目录，
 *      方便参照填写「远端目录」。
 *
 * 网络实现：纯 Node 内置模块（http/https/net/tls/crypto/url/fs/child_process/os），零第三方依赖，
 * 因此插件产物仍是单个 .lxplugin 文件，不需要任何 node_modules。
 *   - WebDAV / FTP：用内置模块直接实现协议。
 *   - SMB：委派给系统自带工具（macOS 的 mount_smbfs、Windows 的 net use、或 samba 的 smbclient），
 *     避免手搓 SMB 二进制协议；若都不可用会给出明确报错。
 *
 * 收藏数据的读取/写回：经由宿主在 window.lx.plugins.listData 上提供的桥
 * （src/plugins/renderer.ts 的 listDataBridge），渲染端收藏存于 SQLite，
 * 必须走 store action，无法直接读文件。
 *
 * 入口以 CommonJS 导出：
 *   module.exports = { setup, uninstall, onConfigChange, onSettingsAction, onQuit }
 */
'use strict'

const http = require('http')
const https = require('https')
const net = require('net')
const tls = require('tls')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { URL } = require('url')
const { execFile, execFileSync } = require('child_process')

/** 默认配置（全部可在「插件管理（侧边栏）→ sync-favorites → 设置」中修改） */
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
  /** SMB：域/工作组（Windows 共享常需要，如 WORKGROUP；留空表示无） */
  domain: '',
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
  /** 浏览到的远端目录列表（UI 状态，持久化） */
  dirListing: '',
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
  let base = String(cfg.host || '').replace(/\/+$/, '')
  // 「端口」字段：host 未带端口时追加（WebDAV 场景）；host 已带端口则尊重 host，不重复拼
  const port = String(cfg.port || '').trim()
  if (port && /^https?:\/\//i.test(base)) {
    try {
      const u = new URL(base)
      if (!u.port) u.port = port
      base = u.origin
    } catch (_) { /* URL 不合法则保持原样，后续请求会给出可读错误 */ }
  }
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

/** 把收藏列表包装成传输信封（可选加密）。返回 JSON 字符串（putFile 直接写入远端） */
function buildEnvelope(lists, cfg) {
  const meta = {
    _app: 'lx-music-desktop',
    _plugin: 'sync-favorites',
    _type: 'favorites',
    _format: 1,
    _createdAt: Date.now(),
  }
  let env
  if (cfg.encrypt && cfg.encryptPassword) {
    const e = encryptText(JSON.stringify(lists), cfg.encryptPassword)
    env = Object.assign({}, meta, {
      _encrypted: true,
      _enc: 'aes-256-cbc',
      _salt: e.salt,
      _iv: e.iv,
      _cipher: e.cipher,
    })
  } else {
    env = Object.assign({}, meta, { _encrypted: false, lists })
  }
  return JSON.stringify(env)
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

/** ============================ 目录列表解析（WebDAV / FTP / SMB 共用） ============================ */

/** 目录条目排序：目录在前，再按名称 */
function sortEntries(a, b) {
  return (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || String(a.name).localeCompare(String(b.name))
}

/** 解析 WebDAV PROPFIND 多状态响应，返回 { name, isDir }[]（排除自身条目）。
 *  注意：<response>/<href> 标签可能带属性（如 <D:response xmlns:lp1="DAV:">，Apache/群晖 常见），
 *  且前缀大小写不定（d: / D:），正则须允许任意属性并忽略大小写。 */
function parseDavListing(xml, baseUrl) {
  const out = []
  const re = /<(d:)?response\b[^>]*>([\s\S]*?)<\/\1response\s*>/gi
  let m
  while ((m = re.exec(xml))) {
    const block = m[2]
    const hrefM = /<(d:)?href\b[^>]*>([\s\S]*?)<\/\1href\s*>/i.exec(block)
    if (!hrefM) continue
    const href = decodeURIComponent(hrefM[2].trim())
    const isDir = /<(d:)?collection\s*\/?>/i.test(block)
    let abs
    try { abs = new URL(href, baseUrl).pathname } catch (e) { abs = href }
    let basePath
    try { basePath = new URL(baseUrl).pathname } catch (e) { basePath = baseUrl }
    if (abs === basePath || abs === basePath + '/') continue // 跳过自身
    let name = abs.replace(/\/+$/, '').split('/').pop()
    if (!name) continue
    try { name = decodeURIComponent(name) } catch (_) { /* 已是明文则保持 */ }
    out.push({ name, isDir })
  }
  out.sort(sortEntries)
  return out
}

/** 解析 FTP MLSD 响应（type=dir;...; name=xxx） */
function parseMlsd(text) {
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const m = /^(.*?);\s*name=(.*)$/.exec(t)
    if (!m) continue
    const isDir = /(^|;)\s*type=dir/i.test(m[1])
    const name = m[2]
    if (name === '.' || name === '..') continue
    out.push({ name, isDir })
  }
  out.sort(sortEntries)
  return out
}

/** 解析 FTP 传统 LIST 的 unix 风格行（drwxr-xr-x ... name） */
function parseUnixList(text) {
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const m = /^([\-dbclps])([rwxST\-]{9})\s+\d+\s+\S+\s+\S+\s+\d+\s+[\w]{3}\s+\d+\s+[\d:]+\s+(.+)$/.exec(t)
    if (!m) continue
    const name = m[3].trim()
    if (name === '.' || name === '..') continue
    out.push({ name, isDir: m[1] === 'd' })
  }
  out.sort(sortEntries)
  return out
}

/** 解析 smbclient `ls` 输出（  name <type> <size> <date> <time>） */
function parseSmbList(text) {
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const m = /^\s*(\S+)\s+([A-Za-z])\s+\d+\s+/.exec(t)
    if (!m) continue
    const name = m[1]
    if (name === '.' || name === '..') continue
    out.push({ name, isDir: m[2].toUpperCase() === 'D' })
  }
  out.sort(sortEntries)
  return out
}

/** 正在运行的子进程（应用退出 / 插件卸载时同步 kill，避免孤儿进程或挂载点残留） */
const activeChildren = new Set()

/** 跑一个子进程命令（无 shell，参数数组化，避免密码注入） */
function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, Object.assign({ timeout: 30000, windowsHide: true }, opts), (err, stdout, stderr) => {
      activeChildren.delete(child)
      if (err) { err.stdout = stdout || ''; err.stderr = stderr || ''; return reject(err) }
      resolve({ stdout: stdout || '', stderr: stderr || '' })
    })
    activeChildren.add(child)
  })
}

/** 同步强制终止全部还在运行的子进程（SIGKILL；Windows 上 Node 会直接 TerminateProcess） */
function killAllChildren() {
  for (const child of [...activeChildren]) {
    try { child.kill('SIGKILL') } catch (_) { try { child.kill() } catch (_) { /* noop */ } }
  }
  activeChildren.clear()
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
    // 部分 WebDAV 服务（如群晖）会拒绝无 User-Agent 的请求，统一带上
    if (!headers['User-Agent'] && !headers['user-agent']) {
      headers['User-Agent'] = 'lx-music-sync/2.12.5'
    }
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

/** 跟随 HTTP 3xx 重定向（最多 5 跳，可跨协议 http↔https）。
 *  群晖等在未认证/根路径常把请求 302 跳到 DSM 登录页，不跟随重定向会被误判成「非 WebDAV」。 */
async function requestFollowRedirect(urlStr, options, hops) {
  hops = hops || 0
  if (hops > 5) return makeRequest(urlStr, options)
  const res = await makeRequest(urlStr, options)
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers && (res.headers['location'] || res.headers['Location'])
    if (loc) {
      try {
        const next = new URL(loc, urlStr).toString()
        const r = await requestFollowRedirect(next, options, hops + 1)
        r.redirected = true // 标记经过了重定向（诊断时区分「根路径跳主页」与「直接打到网页服务」）
        return r
      } catch (_) { /* location 非法则忽略，返回原响应 */ }
    }
  }
  return res
}

/** 从一个文件 URL 解析出「需逐级创建的父目录 URL 列表」（用于 MKCOL 建多层级目录）。
 *  例：http://h:5505/lx-music/favorites/lx_favorites.json
 *    → ['http://h:5505/lx-music/', 'http://h:5505/lx-music/favorites/'] */
function parentDirUrls(fileUrl) {
  const u = new URL(fileUrl)
  const segs = u.pathname.split('/').filter(Boolean)
  segs.pop() // 去掉文件名
  const urls = []
  let acc = u.origin
  for (const s of segs) {
    acc += '/' + s
    urls.push(acc + '/')
  }
  return urls
}

/** 逐级 MKCOL 创建远端父目录；返回创建过程中出现的「非预期」错误。
 *  注意：群晖等 WebDAV 对「不存在的路径」返回 405/409，与「已存在」的语义相同状态码，
 *  故这里对 405/409 用 PROPFIND 二次确认是否真已存在，避免把「创建失败」误判为「已存在」后继续 PUT 到空目录。 */
async function ensureParentDirs(fileUrl, auth, insecure, timeout) {
  const errors = []
  const davOpts = (method, extra) => Object.assign({
    method, auth, secure: insecure ? false : undefined, timeout,
  }, extra || {})
  for (const dirUrl of parentDirUrls(fileUrl)) {
    try {
      const res = await makeRequest(dirUrl, davOpts('MKCOL'))
      if ([201, 204, 207].includes(res.status) || (res.status >= 300 && res.status < 400)) continue // 创建成功 / 重定向
      if ([405, 409].includes(res.status)) {
        // 405/409：可能已存在，用 PROPFIND 验证
        const ex = await makeRequest(dirUrl, davOpts('PROPFIND', { headers: { Depth: '0' } }))
        if (ex.status >= 200 && ex.status < 300) continue // 确实已存在
        errors.push(`${dirUrl} → 目录不存在且无法创建（HTTP ${res.status}）`)
      } else {
        errors.push(`${dirUrl} → HTTP ${res.status}`)
      }
    } catch (e) {
      errors.push(`${dirUrl} → ${e.message}`)
    }
  }
  return errors
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
      const buf = Buffer.isBuffer(content)
        ? content
        : Buffer.from(typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
      const res = await makeRequest(url, {
        method: 'PUT',
        body: buf,
        headers: { 'Content-Type': 'application/octet-stream' },
        auth, secure: insecure ? false : undefined, timeout,
      })
      if (res.status >= 400) {
        const extra = res.status === 405
          ? '（服务器不允许 PUT：群晖等 WebDAV 要求「远端目录」以已存在的共享名开头，例如 homes/你的目录、photo/你的目录；请先点「浏览目录」查看可用共享，再把远端目录改成「共享名/子目录」形式；若该路径需要登录，请确认账号密码已填写）'
          : (res.status === 404 ? '（路径不存在，请先用「浏览目录」确认远端目录正确，且父目录已存在）' : '')
        throw new Error('WebDAV 上传失败：HTTP ' + res.status + extra)
      }
      return res
    },
    async getFile(url) {
      const res = await makeRequest(url, { method: 'GET', auth, secure: insecure ? false : undefined, timeout })
      if (res.status === 404) throw new Error('远端文件不存在（HTTP 404）')
      if (res.status >= 400) throw new Error('WebDAV 下载失败：HTTP ' + res.status)
      return res.body.toString('utf8')
    },
    /** 列出目录（PROPFIND Depth:1），返回 { name, isDir }[]；collectionUrl 以 / 结尾 */
    async listDir(collectionUrl) {
      const url = collectionUrl.endsWith('/') ? collectionUrl : collectionUrl + '/'
      const body = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>'
      const res = await requestFollowRedirect(url, {
        method: 'PROPFIND',
        headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
        body: Buffer.from(body, 'utf8'),
        auth, secure: insecure ? false : undefined, timeout,
      })
      if (res.status >= 400) throw new Error('WebDAV 列目录失败：HTTP ' + res.status)
      if (res.status >= 300) throw new Error('WebDAV 列目录失败：服务器重定向（HTTP ' + res.status + '），地址可能未指向 WebDAV 端点')
      const txt = res.body.toString('utf8')
      if (!/multistatus/i.test(txt)) throw new Error('WebDAV 列目录失败：响应不是 WebDAV 目录列表（HTTP ' + res.status + '），地址可能未指向 WebDAV 端点')
      return parseDavListing(txt, url)
    },
    /** WebDAV 能力探测：OPTIONS 看 Allow / DAV 头，用于诊断「地址是否真的是 WebDAV」 */
    async options(url) {
      const res = await makeRequest(url, { method: 'OPTIONS', auth, secure: insecure ? false : undefined, timeout })
      const h = res.headers || {}
      return {
        status: res.status,
        allow: String(h['allow'] || h['Allow'] || '').toUpperCase(),
        dav: String(h['dav'] || h['DAV'] || ''),
      }
    },
    /** WebDAV 能力探测（更可靠）：用真正的 PROPFIND 判断，比 OPTIONS 头更准。
     *  返回 { isDav, needsAuth }：
     *   - isDav=true,  needsAuth=false：确认是 WebDAV 且可匿名访问
     *   - isDav=true,  needsAuth=true ：确认是 WebDAV，但需要登录/权限校验（如群晖 homes 共享）
     *   - isDav=false                  ：大概率不是 WebDAV 端点或未启用 WebDAV */
    async capability(url) {
      const diag = { status: null, headers: '', body: '' }
      // 1) 优先用真正的 PROPFIND（Depth:0）—— 这才是 WebDAV 的判定依据；跟随重定向（群晖未认证/根路径常 302 跳登录页）
      try {
        const res = await requestFollowRedirect(url, {
          method: 'PROPFIND',
          headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
          body: Buffer.from('<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', 'utf8'),
          auth, secure: insecure ? false : undefined, timeout,
        })
        const bodyText = res.body.toString('utf8')
        diag.status = res.status
        diag.headers = JSON.stringify(res.headers || {}).slice(0, 240)
        diag.body = bodyText.slice(0, 160)
        diag.html = looksLikeHtml(bodyText)
        diag.viaRedirect = res.redirected === true
        const isMulti = /multistatus/i.test(bodyText)
        if (res.status === 207 || (res.status >= 200 && res.status < 300 && isMulti)) return { isDav: true, needsAuth: false, diag }
        if (res.status === 401 || res.status === 403) return { isDav: true, needsAuth: true, diag }
      } catch (e) {
        diag.status = 'ERR'
        diag.body = '请求异常：' + e.message
      }
      // 2) 回退：OPTIONS 看 DAV 头 / Allow（也跟随重定向）
      try {
        const opt = await requestFollowRedirect(url, { method: 'OPTIONS', auth, secure: insecure ? false : undefined, timeout })
        diag.status = diag.status == null ? opt.status : diag.status
        diag.headers = JSON.stringify(opt.headers || {}).slice(0, 240)
        if (!diag.body) {
          const optBody = opt.body.toString('utf8')
          diag.body = optBody.slice(0, 160)
          diag.html = looksLikeHtml(optBody)
          diag.viaRedirect = opt.redirected === true
        }
        if (opt.status === 401 || opt.status === 403) return { isDav: true, needsAuth: true, diag }
        const h = opt.headers || {}
        const allow = String(h['allow'] || h['Allow'] || '').toUpperCase()
        const dav = String(h['dav'] || h['DAV'] || '')
        if (/PROPFIND/.test(allow) || /DAV/i.test(dav)) return { isDav: true, needsAuth: false, diag }
      } catch (e) {
        if (diag.status == null) diag.body = 'OPTIONS 请求异常：' + e.message
      }
      return { isDav: false, needsAuth: false, diag }
    },
    async ensureParent(fileUrl) {
      return await ensureParentDirs(fileUrl, auth, insecure, timeout)
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

  /** 列出目录（优先 MLSD，回落 LIST），返回 { name, isDir }[] */
  async listDir(remoteDir) {
    const dir = remoteDir || '/'
    let data = await this._openData()
    let prep = await this._cmd('MLSD ' + dir)
    let useMlsd = true
    if (prep.code !== '150' && prep.code !== '125') {
      useMlsd = false
      try { data.destroy() } catch (e) { /* noop */ }
      data = await this._openData()
      prep = await this._cmd('LIST ' + dir)
      if (prep.code !== '150' && prep.code !== '125') {
        try { data.destroy() } catch (e) { /* noop */ }
        throw new Error('FTP 列目录失败：' + prep.message)
      }
    }
    const done226 = this._waitFinal()
    const chunks = []
    await new Promise((resolve, reject) => {
      data.on('data', c => chunks.push(c))
      data.on('error', reject)
      data.on('close', resolve)
    })
    await done226
    const text = Buffer.concat(chunks).toString('utf8')
    return useMlsd ? parseMlsd(text) : parseUnixList(text)
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
    async listDir(remoteDir) {
      await client.connect()
      try {
        return await client.listDir(remoteDir)
      } finally {
        client.close()
      }
    },
  }
}

/** ============================ SMB 客户端 ============================
 * 委派给系统自带工具（零第三方依赖）：
 *   - 优先 smbclient（samba，Linux 常见；macOS 可 brew install samba）
 *   - macOS 用 mount_smbfs（系统自带，用户态挂载，无需 root）
 *   - Windows 用 net use（连接 UNC 后走 fs）
 * 文件落点 = //host/<share>/<remotePath 去掉首段>/<filename>
 * 即 remotePath 的首段是「共享名」，其余是共享内的子目录。
 */

/** 探测可用后端：smbclient / mount(macOS) / netuse(Windows) / none */
function detectSmbBackend() {
  try {
    execFileSync('smbclient', ['--version'], { stdio: 'ignore', windowsHide: true })
    return 'smbclient'
  } catch (e) { /* noop */ }
  const p = process.platform
  if (p === 'darwin') return 'mount'
  if (p === 'win32') return 'netuse'
  return 'none'
}

/** 从 fileUrl（格式 host/share/sub/file）解析「共享内子目录 + 文件名」；非法时回落到入参 */
function parseSmbTarget(fileUrl, fallbackSub, fallbackFile) {
  if (fileUrl) {
    const s = String(fileUrl).split('/').filter(Boolean)
    const fn = s[s.length - 1]
    const sd = s.slice(2, s.length - 1).join('/') // 跳过 host(0) 与 share(1)
    if (fn != null && fn !== '') return { subDir: sd, filename: fn }
  }
  return { subDir: fallbackSub, filename: fallbackFile }
}

function createSmbClient(cfg) {
  const host = String(cfg.host || '').replace(/^\/+|\/+$/g, '')
  const rawPath = String(cfg.remotePath || '').replace(/^\/+/, '').replace(/\/+$/g, '')
  const segs = rawPath.split('/').filter(Boolean)
  const share = segs.shift() || ''          // 首段 = 共享名
  const subDir = segs.join('/')             // 共享内的子目录
  const filename = String(cfg.filename || 'lx_favorites.json').replace(/^\/+/, '')
  const user = cfg.username || ''
  const pass = cfg.password || ''
  const domain = cfg.domain || ''
  const timeout = parseInt(cfg.timeout, 10) || 20000
  const q = s => JSON.stringify(String(s))   // 给 smbclient -c 子命令里的路径加引号

  const backend = detectSmbBackend()
  if (backend === 'none') {
    throw new Error('当前系统未找到可用的 SMB 客户端：请安装 samba（提供 smbclient），或在 macOS 用系统自带 mount_smbfs、Windows 用 net use')
  }

  // —— smbclient 后端：单条命令完成一个动作 ——
  const baseArgs = ['//' + host + '/' + share]
  if (user) {
    baseArgs.push('-U', user + (domain ? ';' + domain : '') + '%' + pass)
  } else {
    baseArgs.push('-N', '-U', 'guest') // 匿名
  }
  function smbCmd(command) {
    return run('smbclient', baseArgs.concat(['-c', command]), { timeout })
  }
  // 从传入的 fileUrl（格式 host/share/sub/file）解析出「共享内子目录 + 文件名」，
  // 这样测试连接用临时文件名时也不会覆盖真实备份文件。
  function targetFrom(fileUrl) {
    return parseSmbTarget(fileUrl, subDir, filename)
  }
  async function smbPut(fileUrl, content) {
    const t = targetFrom(fileUrl)
    const tmp = path.join(os.tmpdir(), 'lx-smb-put-' + Date.now())
    fs.writeFileSync(tmp, content)
    try { await smbCmd('put ' + q(tmp) + ' ' + q([t.subDir, t.filename].filter(Boolean).join('/'))) }
    finally { try { fs.unlinkSync(tmp) } catch (e) { /* noop */ } }
  }
  async function smbGet(fileUrl) {
    const t = targetFrom(fileUrl)
    const tmp = path.join(os.tmpdir(), 'lx-smb-get-' + Date.now())
    await smbCmd('get ' + q([t.subDir, t.filename].filter(Boolean).join('/')) + ' ' + q(tmp))
    try { return fs.readFileSync(tmp, 'utf8') } finally { try { fs.unlinkSync(tmp) } catch (e) { /* noop */ } }
  }
  async function smbMkdir(fileUrl) {
    const t = targetFrom(fileUrl)
    if (!t.subDir) return
    const parts = t.subDir.split('/').filter(Boolean)
    let cur = ''
    for (const p of parts) { cur += (cur ? '/' : '') + p; await smbCmd('mkdir ' + q(cur)).catch(() => {}) }
  }
  async function smbList(dir) {
    const rel = dir || '.' // dir 已是「共享内相对路径」（含 subDir）
    const { stdout } = await smbCmd('ls ' + q(rel))
    return parseSmbList(stdout)
  }

  // —— 挂载后端（macOS mount_smbfs / Windows net use）：挂载后走 fs ——
  let fsRoot = ''
  let mountRoot = ''
  function smbUrlUserPart() {
    let up = ''
    if (domain) up += encodeURIComponent(domain) + ';'
    if (user) up += encodeURIComponent(user)
    if (pass) up += ':' + encodeURIComponent(pass)
    return up
  }
  async function connectFs() {
    if (backend === 'mount') {
      mountRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-smb-'))
      const url = '//' + (smbUrlUserPart() ? smbUrlUserPart() + '@' : '') + host + '/' + share
      await run('mount_smbfs', [url, mountRoot], { timeout })
      fsRoot = mountRoot
    } else { // win32 net use
      fsRoot = '\\\\' + host + '\\' + share
      const args = [fsRoot]
      if (user) {
        args.push('/user:' + (domain ? domain + '\\' : '') + user)
        if (pass) args.push(pass)
      }
      args.push('/persistent:no')
      await run('net', ['use'].concat(args), { timeout })
    }
  }
  async function disconnectFs() {
    if (backend === 'mount') {
      try { await run('umount', [mountRoot], { timeout }) }
      catch (e) { try { await run('diskutil', ['unmount', mountRoot], { timeout }) } catch (_) { /* noop */ } }
    } else {
      try { await run('net', ['use', fsRoot, '/delete', '/y'], { timeout }) } catch (_) { /* noop */ }
    }
  }
  async function withFs(fn) {
    await connectFs()
    try { return await fn() } finally { await disconnectFs() }
  }

  return {
    protocol: 'smb',
    async putFile(fileUrl, content) {
      if (backend === 'smbclient') return smbPut(fileUrl, content)
      return withFs(() => {
        const t = targetFrom(fileUrl)
        const dir = path.join(fsRoot, t.subDir)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, t.filename), content)
      })
    },
    async getFile(fileUrl) {
      if (backend === 'smbclient') return smbGet(fileUrl)
      return withFs(() => {
        const t = targetFrom(fileUrl)
        return fs.readFileSync(path.join(fsRoot, t.subDir, t.filename), 'utf8')
      })
    },
    async ensureParent(fileUrl) {
      if (backend === 'smbclient') return smbMkdir(fileUrl)
      return withFs(() => {
        const t = targetFrom(fileUrl)
        if (t.subDir) fs.mkdirSync(path.join(fsRoot, t.subDir), { recursive: true })
      })
    },
    async remove(fileUrl) {
      if (backend === 'smbclient') {
        const t = targetFrom(fileUrl)
        return smbCmd('rm ' + q([t.subDir, t.filename].filter(Boolean).join('/'))).catch(() => {})
      }
      return withFs(() => {
        const t = targetFrom(fileUrl)
        try { fs.unlinkSync(path.join(fsRoot, t.subDir, t.filename)) } catch (e) { /* noop */ }
      })
    },
    async listDir(dir) {
      if (backend === 'smbclient') return smbList(dir)
      return withFs(() => {
        const p = path.join(fsRoot, dir || '') // dir 已是「共享内相对路径」
        const names = fs.readdirSync(p)
        return names.filter(n => n !== '.' && n !== '..').map(n => {
          let isDir = false
          try { isDir = fs.statSync(path.join(p, n)).isDirectory() } catch (e) { /* noop */ }
          return { name: n, isDir }
        }).sort(sortEntries)
      })
    },
  }
}

/** ============================ 客户端工厂 + 同步逻辑 ============================ */

function buildClient(cfg) {
  const type = String(cfg.type || 'webdav').toLowerCase()
  if (type === 'ftp') return createFtpClient(cfg)
  if (type === 'smb') return createSmbClient(cfg)
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

/** 还原为导入/导出用的列表数组（id + name + list）。
 *  兼容两种集合形状：normalizeCollection/filterByScope 的 { map, order } 与
 *  mergeCollections 的 { collection, order, conflicts }（历史上两次命名并存，这里统一容错）。 */
function denormalizeCollection(norm) {
  const map = (norm && (norm.map || norm.collection)) || {}
  const order = (norm && norm.order) || []
  const ids = order.slice()
  for (const id of Object.keys(map)) if (!ids.includes(id)) ids.push(id)
  return ids.map(id => ({ id, name: map[id] && map[id].name, list: map[id] ? map[id].songs.slice() : [] }))
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

/** 计算「浏览目录」目标：返回 { dir, label }；dir 是该协议 listDir 期望的形式 */
function browseTargetDir(cfg) {
  const type = String(cfg.type || 'webdav').toLowerCase()
  if (type === 'smb') {
    const rawPath = String(cfg.remotePath || '').replace(/^\/+/, '').replace(/\/+$/g, '')
    const segs = rawPath.split('/').filter(Boolean)
    segs.shift() // 去掉共享名（SMB listDir 的相对路径是共享内子目录）
    return {
      dir: segs.join('/'),
      label: 'smb://' + (cfg.host || '') + '/' + rawPath,
    }
  }
  const fileUrl = buildRemoteUrl(cfg)
  const parent = fileUrl.replace(/[^/]+$/, '')
  return { dir: parent, label: parent }
}

/** 把目录项渲染为可读文本。按需求：浏览只显示「URL + 共 xx 项」，不列出具体内容。
 *  仅在触发「逐级回退」时附带一条简短提示（说明填写的目录列不出、已回退），便于排查配置错误。 */
function formatListing(entries, label, note) {
  return `「${label}」${note ? '　' + note : ''}　目录下共 ${entries.length} 项`
}

/** 判断响应体是否是 HTML 网页（而非 WebDAV 的 XML）。用于诊断「地址指向的是网页服务而非 WebDAV」。 */
function looksLikeHtml(text) {
  const t = String(text || '').trim().toLowerCase()
  return t.startsWith('<!doctype') || t.startsWith('<html') || t.includes('<html') || t.includes('<head>')
}

/** 从「某个远端目录 URL」逐级向上收集候选 URL（最深的在前，根 / 在最后兜底）。
 *  例：http://h:5505/lx-music/favorites/ →
 *      [http://h:5505/lx-music/favorites/, http://h:5505/lx-music/, http://h:5505/]
 *  这样当配置的远端目录不存在时，能一路回退到 WebDAV 根，列出真实共享（群晖的共享就挂在根下）。 */
function collectAncestorUrls(dir) {
  if (!/^https?:\/\//i.test(dir)) return [dir] // SMB 等相对路径不在此回退
  const u = new URL(dir)
  const segs = u.pathname.split('/').filter(Boolean)
  const chain = []
  let acc = u.origin
  for (const s of segs) {
    acc += '/' + s
    chain.push(acc + '/')
  }
  chain.reverse() // 最深在前
  chain.push(u.origin + '/') // 根兜底
  return chain
}

/** 浏览远端目录：列出连接地址/远端目录下的内容，返回可读文本；列不出时逐级回退到根，再给出可操作诊断 */
async function browseDir(api, cfg) {
  const client = buildClient(cfg)
  const { dir, label } = browseTargetDir(cfg)
  const levels = collectAncestorUrls(dir)
  // 逐级回退（含根 /），第一个能列出的层级即作为参照
  for (const lv of levels) {
    try {
      const entries = await client.listDir(lv)
      const note = (lv === dir)
        ? ''
        : `（您填的「${label}」列不出，已回退到「${lv}」；群晖等 WebDAV 的共享挂在根下，请把「远端目录」设成 共享名/子目录 形式，例如 homes/lx-music、photo/lx-music）`
      return formatListing(entries, lv, note)
    } catch (e) { /* 该层级列不出，尝试更浅的层级 */ }
  }
  // 任何层级（含根）都列不出 → WebDAV 能力诊断：用真正的 PROPFIND 探测（比 OPTIONS 头可靠）
  const rootUrl = levels[levels.length - 1] || (String(cfg.host || '').replace(/\/+$/, '') + '/')
  if (typeof client.capability === 'function') {
    const cap = await client.capability(rootUrl)
    if (cap.isDav && cap.needsAuth) {
      throw new Error(`该地址是 WebDAV，但需要登录或有权限校验（探测返回 401/403），根目录也列不出。请确认「账号」「密码」已正确填写（群晖 WebDAV 默认用 DSM 账号，需在 DSM 控制面板 → 应用门户 → WebDAV 中开启服务），且账号对该共享有读取权限。`)
    }
    if (cap.isDav) {
      throw new Error(`该地址是 WebDAV，但根目录也列不出（可能账号无该共享读取权限，或「远端目录」不存在）。请确认账号密码已填写、「远端目录」以已存在的共享名开头（如 homes/lx-music、photo/lx-music），且账号对该共享有读取权限。原始错误：${label}`)
    }
    const d = cap.diag || {}
    const bodySnip = d.body ? String(d.body).replace(/[\r\n]+/g, ' ').slice(0, 120) : ''
    const diagText = d.status != null
      ? `（服务器实际返回：HTTP ${d.status}${bodySnip ? '，响应体前若干字符：' + bodySnip : ''}）`
      : ''
    if (d.html) {
      throw new Error(`探测发现该地址返回的是「HTML 网页」而不是 WebDAV 的 XML 响应${diagText}。这说明你打到的是网页服务（极可能是群晖 DSM 管理界面，或路由器/其它 Web 服务），不是 WebDAV 端点。WebDAV 在群晖里是「独立服务、独立端口」：请到 DSM「控制面板 → 文件服务 → WebDAV」勾选启用 WebDAV / WebDAV HTTPS，并记下它显示的端口（HTTP 通常 5005、HTTPS 通常 5006）；然后把插件里 host 改成 http://192.168.31.120:<WebDAV端口>（不要用 DSM 管理界面的端口，如 5505/5000）。若 Finder 能连，请把 Finder「前往 → 连接服务器」里填的地址完整发我。`)
    }
    throw new Error(`该地址未通过 WebDAV 能力探测（PROPFIND/OPTIONS 均不像 WebDAV 端点）。${diagText}大概率不是 WebDAV 端点或未启用 WebDAV。请确认 host 指向 WebDAV 挂载点（群晖通常为 http://IP:5005 或 https://IP:5006），并检查端口与账号密码；若 Finder 能连但插件不能，多半是端口/协议不一致（Finder 可能用了 https 或不同端口），请把 Finder 里显示的 WebDAV 地址完整发我。`)
  }
  throw new Error(`无法列出目录（含根）：${label}`)
}

/** 连接测试：在目标目录放一个临时文件并回读，再删除；失败时探测 WebDAV 能力并给出可操作提示 */
async function testConnection(api, cfg) {
  const client = buildClient(cfg)
  const fileUrl = buildRemoteUrl(cfg)
  const parent = fileUrl.replace(/[^/]+$/, '')
  const tmpUrl = parent + '.lx_sync_test_' + Date.now()
  const probe = JSON.stringify({ _test: true, _t: Date.now() })
  // 建目录：收集非预期错误（已存在等可接受），有真实错误则记日志但不直接阻断（部分服务器允许 PUT 自动建目录）
  const mkErrors = await client.ensureParent(fileUrl)
  if (mkErrors && mkErrors.length) {
    api.logger.warn('sync-favorites 创建远端目录时部分失败（可能不影响写入）：', mkErrors.join('; '))
  }
  try {
    await client.putFile(tmpUrl, probe)
  } catch (e) {
    // PUT 失败：WebDAV 客户端用真正的 PROPFIND 探测能力，给出更精准诊断（比 OPTIONS 头可靠）
    let hint = ''
    if (typeof client.capability === 'function') {
      try {
        const cap = await client.capability(parent)
        if (cap.isDav && cap.needsAuth) {
          hint = '；该地址是 WebDAV 但需要登录/权限（探测返回 401/403），请确认账号密码正确（群晖 WebDAV 默认用 DSM 账号，需在 DSM 应用门户→WebDAV 开启服务）'
        } else if (!cap.isDav) {
          const d = cap.diag || {}
          const bodySnip = d.body ? String(d.body).replace(/[\r\n]+/g, ' ').slice(0, 120) : ''
          const diagText = d.status != null
            ? `（服务器返回：HTTP ${d.status}${bodySnip ? '，响应体前若干字符：' + bodySnip : ''}）`
            : ''
          if (d.html) {
            hint = '；该地址返回的是 HTML 网页而非 WebDAV 的 XML' + diagText + '，说明指向的是网页服务（极可能是群晖 DSM 管理界面）而非 WebDAV 端点。请在 DSM「控制面板 → 文件服务 → WebDAV」启用服务并使用其显示的端口（HTTP 通常 5005、HTTPS 通常 5006），不要用 DSM 管理界面的端口'
          } else {
            hint = '；该地址未通过 WebDAV 能力探测' + diagText + '，大概率未指向 WebDAV 挂载点或未启用 WebDAV，请确认 host/端口/账号密码'
          }
        }
      } catch (_) { /* 探测失败不影响主错误 */ }
    } else if (String(cfg.type || '').toLowerCase() === 'smb') {
      hint = '；SMB 连接失败请检查：服务器地址是否填 IP/主机名（不带 smb://）、remotePath 首段是否为共享名、账号/域/密码是否正确'
    }
    throw new Error(e.message + hint)
  }
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
    buildClient,
    buildRemoteUrl,
    testConnection,
    browseDir,
    browseTargetDir,
    doSync,
    parseEnvelope,
    buildEnvelope,
    collectAncestorUrls,
    ensureParentDirs,
    parentDirUrls,
    formatListing,
    looksLikeHtml,
    parseDavListing,
    parseMlsd,
    parseUnixList,
    parseSmbList,
    detectSmbBackend,
    createSmbClient,
    parseSmbTarget,
  },
  setup(api) {
    const state = Object.assign({}, DEFAULT_CONFIG, api.getConfig())
    let timer = null

    // 应用退出 / 插件卸载时由宿主同步调用：kill 掉还在跑的子进程（smbclient / mount_smbfs / net use 等）
    api.track(killAllChildren)

    const persist = (patch) => { api.setConfig(patch) }

    const startTimer = () => {
      stopTimer()
      const minutes = Math.max(1, parseInt(state.interval, 10) || 1)
      // 用宿主代管的 setInterval：应用退出 / 插件卸载时由宿主自动清除
      timer = api.setInterval(() => {
        void execute('timer').catch(e => api.logger.error('sync-favorites 定时同步异常：', e))
      }, minutes * 60000)
    }
    const stopTimer = () => {
      if (timer) { api.clearInterval(timer); timer = null }
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

    /** 浏览远端目录并写入 state.dirListing（持久化，面板「目录列表」区展示） */
    const doBrowse = async() => {
      try {
        const text = await browseDir(api, state)
        state.dirListing = text
        state.lastResult = `浏览目录成功（${formatTime(Date.now())}）`
      } catch (e) {
        state.dirListing = '浏览失败：' + e.message
        state.lastResult = `浏览目录失败（${formatTime(Date.now())}）：${e.message}`
        api.logger.error('sync-favorites 浏览目录失败：', e)
      } finally {
        persist({ dirListing: state.dirListing, lastResult: state.lastResult })
      }
    }

    ctx = { api, state, startTimer, stopTimer, execute, doBrowse, _connSig: '', _browseTimer: null }

    /* ---------- 声明式设置面板 ---------- */
    /** 当前协议（容错：接受 webdav/ftp/smb 的任意大小写与多余空格） */
    const currentType = () => {
      const t = String(state.type || 'webdav').trim().toLowerCase()
      return t === 'ftp' ? 'ftp' : t === 'smb' ? 'smb' : 'webdav'
    }
    /**
     * 按当前协议构建字段列表：连接类字段只显示当前协议需要的项，
     * 同步行为类字段（方向/冲突/范围/定时/加密）三种协议通用。
     * 面板在按钮动作后会重拉 spec，因此切协议时重注册即可立即生效（无需改宿主）。
     */
    const buildFields = () => {
      const t = currentType()
      const protoFields = t === 'webdav'
        ? [
            { type: 'text', key: 'host', label: '服务器地址', placeholder: 'http://192.168.31.120 或 https://dav.example.com', default: '', tip: '含协议前缀；群晖填 http://IP，端口填到下方「端口」字段（不要拼进地址）。' },
            { type: 'text', key: 'port', label: '端口', placeholder: '留空使用默认 80/443；群晖 WebDAV 常为 5005/5006', default: '', tip: '留空使用协议默认端口。' },
            { type: 'switch', key: 'insecure', label: '忽略证书校验（自签名 HTTPS）', default: false },
          ]
        : t === 'ftp'
          ? [
              { type: 'text', key: 'host', label: '服务器地址', placeholder: 'ftp.example.com 或 192.168.1.10', default: '', tip: '只填主机名/IP，不带 ftp:// 前缀。' },
              { type: 'text', key: 'port', label: '端口', placeholder: '留空使用默认 21', default: '', tip: '留空使用默认端口 21。' },
              { type: 'switch', key: 'secure', label: '启用 FTPS（AUTH TLS 加密）', default: false },
              { type: 'switch', key: 'passive', label: '被动模式（PASV）', default: true, tip: '绝大多数 FTP 服务器需要开启；如遇连接超时再尝试关闭。' },
            ]
          : [
              { type: 'text', key: 'host', label: '服务器地址', placeholder: '192.168.1.10', default: '', tip: '只填 IP/主机名，不要带 smb:// 前缀。' },
              { type: 'text', key: 'port', label: '端口', placeholder: '留空使用默认 445', default: '', tip: '留空使用默认端口 445。' },
              { type: 'text', key: 'domain', label: '域/工作组', placeholder: '如 WORKGROUP，留空表示无', default: '' },
            ]
      const pathTip = t === 'smb'
        ? '备份文件所在目录（不含文件名）。首段必须是共享名，如 share/subdir。填好地址后点「浏览目录」可列出可用共享，照着抄即可。'
        : '备份文件所在目录（不含文件名）。须以 NAS 上已存在的「共享名」开头，如 homes/lx-music、photo/lx-music。填好地址后点「浏览目录」（或改地址自动触发）可列出可用共享，照着抄即可。'
      return [
        {
          type: 'buttons',
          buttons: [
            { label: 'WebDAV', action: 'use-webdav', disabled: t === 'webdav' },
            { label: 'FTP', action: 'use-ftp', disabled: t === 'ftp' },
            { label: 'SMB', action: 'use-smb', disabled: t === 'smb' },
          ],
          suffix: () => `当前协议：${t.toUpperCase()}`,
          tip: '同步协议（单选）：点击切换，当前协议的按钮为选中（灰置）状态；下方只显示该协议需要填写的内容。',
        },
        ...protoFields,
        { type: 'text', key: 'remotePath', label: '远端目录', placeholder: t === 'smb' ? 'share/subdir' : 'homes/lx-music', default: 'lx-music/favorites', tip: pathTip },
        { type: 'text', key: 'filename', label: '文件名', placeholder: 'lx_favorites.json', default: 'lx_favorites.json' },
        { type: 'text', key: 'username', label: '账号', placeholder: '留空表示匿名/无认证', default: '' },
        { type: 'password', key: 'password', label: '密码', placeholder: '留空表示不需要密码', default: '' },
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
            { label: '浏览目录', action: 'browse' },
          ],
        },
        {
          type: 'info',
          label: '目录列表（填好协议/地址后自动显示，或点「浏览目录」）',
          text: () => (ctx && ctx.state.dirListing) || (state.dirListing || '尚未浏览'),
        },
        {
          type: 'info',
          label: '状态',
          text: () => state.lastResult || '尚未执行',
          suffix: () => (state.lastSyncAt ? `上次同步：${formatTime(state.lastSyncAt)}` : '从未同步'),
        },
      ]
    }
    /** 按当前协议（重）注册设置面板字段 */
    const applySettings = () => {
      if (api.registerSettings) {
        api.registerSettings({ title: '我的列表同步', fields: buildFields() })
      }
    }

    ctx = { api, state, startTimer, stopTimer, execute, doBrowse, applySettings, currentType, lastRegType: currentType(), _connSig: '', _browseTimer: null }
    applySettings()

    api.hooks.on('app:ready', () => {
      api.logger.info(`已就绪：sync-favorites v${api.version}；协议 ${state.type}，方向 ${state.mode}`)
      if (state.autoSync && state.interval > 0) startTimer()
    })
  },

  /** 设置面板改动配置后调用：同步进内存，并按需重启定时器；连接地址变更时自动浏览目录 */
  onConfigChange(next) {
    if (!ctx) return undefined
    const prevAuto = ctx.state.autoSync
    const prevInt = ctx.state.interval
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (key in next) ctx.state[key] = next[key]
    }
    // 协议变化（如手工改 config.json）→ 按新协议重注册面板字段
    const nowType = ctx.currentType()
    if (ctx.lastRegType !== nowType) {
      ctx.lastRegType = nowType
      ctx.applySettings()
    }
    if (ctx.state.autoSync !== prevAuto || ctx.state.interval !== prevInt) {
      if (ctx.state.autoSync && ctx.state.interval > 0) ctx.startTimer()
      else ctx.stopTimer()
    }
    // 连接地址相关字段变化 → 防抖后自动浏览目录，供参照配置目标目录
    const connSig = [ctx.state.type, ctx.state.host, ctx.state.port, ctx.state.domain, ctx.state.username, ctx.state.password].join('|')
    if (connSig !== ctx._connSig) {
      ctx._connSig = connSig
      if (ctx._browseTimer) api.clearTimeout(ctx._browseTimer)
      if (ctx.state.host) {
        ctx._browseTimer = api.setTimeout(() => { void ctx.doBrowse().catch(e => api.logger.error('sync-favorites 自动浏览失败：', e)) }, 900)
      }
    }
    return undefined
  },

  /** 设置面板按钮点击 */
  onSettingsAction(action) {
    if (!ctx) return undefined
    // 协议单选：写入配置并按新协议重注册面板字段（面板动作后会重拉 spec，字段立即切换）
    if (action === 'use-webdav' || action === 'use-ftp' || action === 'use-smb') {
      const t = action.slice(4)
      if (ctx.currentType() !== t) {
        ctx.state.type = t
        ctx.api.setConfig({ type: t })
        ctx.lastRegType = t
        ctx.applySettings()
      }
      return undefined
    }
    if (action === 'backup') return ctx.execute('upload')
    if (action === 'restore') return ctx.execute('download')
    if (action === 'test') return ctx.execute('test')
    if (action === 'browse') return ctx.doBrowse()
    if (action === 'sync') return ctx.execute(ctx.state.mode)
    return undefined
  },

  /**
   * 应用退出（关闭/重载窗口）时由宿主同步调用：终止后台工作（定时器、子进程）。
   * 这不是卸载——不还原任何状态，只保证没有后台任务残留到退出之后。
   */
  onQuit() {
    if (ctx) { ctx.stopTimer(); if (ctx._browseTimer) ctx.api.clearTimeout(ctx._browseTimer) }
    killAllChildren()
  },

  /** 卸载/禁用：清理定时器与子进程 */
  uninstall() {
    if (ctx) { ctx.stopTimer(); if (ctx._browseTimer) ctx.api.clearTimeout(ctx._browseTimer) }
    killAllChildren()
    ctx = null
    console.log('[plugin:sync-favorites] 已卸载，定时器与子进程已清理')
  },
}
