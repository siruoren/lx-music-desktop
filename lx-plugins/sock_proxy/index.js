/**
 * sock_proxy —— 为客户端提供 SOCKS5 代理支持。
 *
 * 背景：客户端原生的网络代理只支持 HTTP 代理（`src/renderer/utils/request.js` 里
 * 固定用 `tunnel` 的 `httpOverHttp` / `httpsOverHttp` 构造 agent），而 `tunnel`
 * 本身不支持 SOCKS。本插件通过插件系统的「代理 agent 接管点」提供自实现的
 * SOCKS5 agent，从而让 SOCKS5 代理真正生效，且不改动原请求逻辑。
 *
 * 接管点约定（见 src/renderer/utils/request.js 与 src/plugins/renderer.ts）：
 *   window.lx.pluginNetAgent = (url, proxyOptions) => agent | undefined
 *   - 返回 agent → 用该 agent 发请求（本插件返回 SOCKS5 agent）
 *   - 返回假值  → 不接管，交还原逻辑（HTTP 代理 / 直连）
 *   是否接管**只取决于本插件自己的配置**（开关是否打开、地址是否填写），
 *   与 app「设置 → 网络」里那套 HTTP 代理配置相互独立、互不影响。
 *
 * 配置：全部在「插件管理（侧边栏）→ sock_proxy → 设置」中填写
 * （启用开关 / 地址 / 端口 / 账户名 / 密码 / 远程 DNS），
 * 保存在插件目录的 config.json，下次启动客户端自动生效。
 * 账户名与密码都留空时按 RFC 1928 使用「无认证」方式（AUTH_NONE）。
 *
 * 生效范围（两层，缺一不可）：
 *  1. **Node 请求层** —— 所有经 `src/renderer/utils/request.js` 的请求：各音乐源的搜索 /
 *     歌单 / 歌词 / 评论 / 榜单 / 热词等。通过接管点 `window.lx.pluginNetAgent` 生效。
 *  2. **Chromium 会话层** —— `<audio>` / `<img>` 等由 Chromium 直接发起的请求，
 *     即**音乐播放**与封面加载。它们不经过 request.js，因此必须把代理设到 BrowserWindow
 *     的会话上（`api.setSessionProxy`）。会话层**一律通过本地 HTTP 桥**转发：
 *       · Chromium 对 `socks5://` 代理会在**本地解析 DNS**（远程 DNS 不生效），本地解析
 *         不了/被污染的域名播放就会失败 —— 而 HTTP 代理的 CONNECT 会把域名原样交给
 *         代理端解析，正好绕开这个限制；
 *       · Chromium 还会静默忽略 SOCKS URL 里的用户名/密码，桥里一并完成 RFC1929 认证。
 *     只做第 1 层时会出现「测试通过、接口生效，但播放依然直连/失败」的现象。
 *
 * 未覆盖：下载任务另有一份独立的 agent 构造（`src/common/utils/download/util.ts`，
 * 运行在 download worker 中、且 worker 里拿不到 window.lx），详见 README「覆盖范围」。
 *
 * 入口以 CommonJS 导出（构建脚本会把它包进单个 .lxplugin 文件）：
 *   module.exports = { setup, uninstall, onUpdate, onConfigChange, onSettingsAction }
 */
'use strict'

const net = require('net')
const tls = require('tls')
const http = require('http')
const https = require('https')
const dns = require('dns')

/** 启动诊断（顶层就初始化）：模块被求值即写第一条，用于区分「没求值」与「setup 没被调用」 */
const bootLog = (() => {
  let fsMod, pathMod, osMod
  try {
    fsMod = require('fs'); pathMod = require('path'); osMod = require('os')
  } catch (e) {
    console.error('[plugin:sock_proxy] 诊断模块 require 失败：', e)
    return () => {}
  }
  const dirOf = typeof __dirname === 'string' && __dirname ? __dirname : null
  const candidates = [
    dirOf ? pathMod.join(dirOf, 'boot-debug.log') : null,
    pathMod.join(osMod.tmpdir(), 'sock_proxy-boot-debug.log'),
  ].filter(Boolean)
  const errors = []
  return (msg) => {
    const line = `${new Date().toISOString()} [pid:${process.pid}] ${msg}\n`
    for (const f of candidates) {
      try {
        fsMod.appendFileSync(f, line)
        return
      } catch (e) {
        errors.push(`${f}: ${e.message}`)
      }
    }
    console.error('[plugin:sock_proxy] 诊断日志写入失败：', errors.join('；'), '——', line.trim())
  }
})()
bootLog(`模块顶层求值完成（__dirname=${typeof __dirname === 'string' ? __dirname : String(typeof __dirname)}）`)

const SOCKS_VERSION = 0x05
const AUTH_NONE = 0x00
const AUTH_USERPASS = 0x02
const CMD_CONNECT = 0x01
const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04
const AUTH_VERSION = 0x01

/** SOCKS5 应答码 → 可读信息（RFC 1928） */
const REP_MESSAGE = {
  0x01: '通用 SOCKS 服务器故障',
  0x02: '规则不允许该连接',
  0x03: '网络不可达',
  0x04: '主机不可达',
  0x05: '连接被拒绝',
  0x06: 'TTL 超时',
  0x07: '不支持的命令',
  0x08: '不支持的地址类型',
}

/** 主机/端口未填时的默认值 */
const DEFAULT_SOCKS_PORT = 1080
const DEFAULT_TIMEOUT = 15000

/** ============================ 小工具 ============================ */

function ipv4ToBuffer(addr) {
  const parts = addr.split('.')
  const buf = Buffer.alloc(4)
  for (let i = 0; i < 4; i++) buf[i] = parseInt(parts[i], 10) || 0
  return buf
}

/** 把 IPv6 文本展开成 16 字节；支持 `::` 缩写与 `::ffff:1.2.3.4` 内嵌写法 */
function ipv6ToBuffer(addr) {
  let s = String(addr)
  const zone = s.indexOf('%')
  if (zone !== -1) s = s.slice(0, zone)

  // 内嵌 IPv4：a:b:1.2.3.4 → a:b:0102:0304
  const embedded = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (embedded) {
    const tail = ipv4ToBuffer(embedded[2])
    s = `${embedded[1]}${((tail[0] << 8) | tail[1]).toString(16)}:${((tail[2] << 8) | tail[3]).toString(16)}`
  }

  const idx = s.indexOf('::')
  let head = []
  let tail = []
  if (idx === -1) {
    head = s.split(':')
  } else {
    head = s.slice(0, idx).split(':').filter(Boolean)
    tail = s.slice(idx + 2).split(':').filter(Boolean)
  }
  const missing = 8 - head.length - tail.length
  if (missing < 0) throw new Error(`非法 IPv6 地址：${addr}`)
  const parts = [...head, ...new Array(idx === -1 ? 0 : missing).fill('0'), ...tail]
  if (parts.length !== 8) throw new Error(`非法 IPv6 地址：${addr}`)
  const buf = Buffer.alloc(16)
  parts.forEach((p, i) => buf.writeUInt16BE(parseInt(p, 16) || 0, i * 2))
  return buf
}

function portToBuffer(port) {
  const p = Number(port)
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`非法端口：${port}`)
  const buf = Buffer.alloc(2)
  buf.writeUInt16BE(p, 0)
  return buf
}

/**
 * 从 socket 上精确读取 n 字节后回调。
 * 用 paused 模式 + read(n)（精确长度）实现，因此不会多读，也就不会吞掉隧道数据。
 */
function readExactly(socket, n, onChunk, onError) {
  const onReadable = () => {
    let chunk
    try {
      chunk = socket.read(n)
    } catch (err) {
      socket.removeListener('readable', onReadable)
      onError(err)
      return
    }
    if (chunk === null) return // 数据还没到齐，等下一次 readable
    socket.removeListener('readable', onReadable)
    onChunk(chunk)
  }
  socket.on('readable', onReadable)
  onReadable() // 处理可能已经在缓冲区里的数据
}

/**
 * 构造 SOCKS5 的 CONNECT 请求报文。
 * remoteDns=true 时用 ATYP_DOMAIN 交给代理去解析域名（推荐，避免本地 DNS 泄漏）；
 * remoteDns=false 时先本地解析再把 IP 发给代理。
 */
function encodeTarget(host, port, remoteDns, onReady) {
  if (net.isIPv4(host)) {
    const addr = Buffer.concat([Buffer.from([ATYP_IPV4]), ipv4ToBuffer(host), portToBuffer(port)])
    return onReady(null, Buffer.concat([Buffer.from([SOCKS_VERSION, CMD_CONNECT, 0x00]), addr]))
  }
  if (net.isIPv6(host)) {
    const addr = Buffer.concat([Buffer.from([ATYP_IPV6]), ipv6ToBuffer(host), portToBuffer(port)])
    return onReady(null, Buffer.concat([Buffer.from([SOCKS_VERSION, CMD_CONNECT, 0x00]), addr]))
  }
  if (remoteDns) {
    const name = Buffer.from(host, 'utf8')
    if (name.length > 255) return onReady(new Error(`域名过长，无法交给 SOCKS5 代理解析：${host}`))
    const addr = Buffer.concat([Buffer.from([ATYP_DOMAIN, name.length]), name, portToBuffer(port)])
    return onReady(null, Buffer.concat([Buffer.from([SOCKS_VERSION, CMD_CONNECT, 0x00]), addr]))
  }
  dns.lookup(host, (err, address) => {
    if (err) return onReady(new Error(`本地解析域名失败（${host}）：${err.message}`))
    // address 已是 IP，走上面的 IP 分支，不会再次递归解析
    encodeTarget(address, port, true, onReady)
  })
}

/** ============================ SOCKS5 握手 ============================ */

/**
 * 与 SOCKS5 代理建立到 targetHost:targetPort 的隧道。
 * @param {object} opts proxyHost/proxyPort/targetHost/targetPort/username/password/remoteDns/timeout
 * @param {(err: Error|null, socket?: net.Socket) => void} callback
 */
function socksConnect(opts, callback) {
  let settled = false
  const socket = net.connect({ host: opts.proxyHost, port: opts.proxyPort })

  const fail = (err) => {
    if (settled) return
    settled = true
    socket.removeAllListeners('timeout')
    socket.destroy()
    callback(err)
  }
  const succeed = () => {
    if (settled) return
    settled = true
    socket.setTimeout(0)
    callback(null, socket)
  }

  socket.setTimeout(opts.timeout || DEFAULT_TIMEOUT)
  socket.once('timeout', () => { fail(new Error(`SOCKS5 代理握手超时（${opts.proxyHost}:${opts.proxyPort}）`)) })
  socket.once('error', (err) => { fail(new Error(`连接 SOCKS5 代理失败（${opts.proxyHost}:${opts.proxyPort}）：${err.message}`)) })

  const hasAuth = !!(opts.username || opts.password)

  const sendAuth = () => {
    const user = Buffer.from(opts.username || '', 'utf8')
    const pass = Buffer.from(opts.password || '', 'utf8')
    socket.write(Buffer.concat([
      Buffer.from([AUTH_VERSION, user.length]), user,
      Buffer.from([pass.length]), pass,
    ]))
    readExactly(socket, 2, (buf) => {
      if (buf[0] !== AUTH_VERSION) return fail(new Error(`SOCKS5 认证版本不匹配：${buf[0]}`))
      if (buf[1] !== 0x00) return fail(new Error('SOCKS5 用户名/密码认证失败'))
      sendConnect()
    }, fail)
  }

  const sendConnect = () => {
    encodeTarget(opts.targetHost, opts.targetPort, opts.remoteDns !== false, (err, req) => {
      if (err) return fail(err)
      socket.write(req)
    })
    readExactly(socket, 4, (head) => {
      if (head[0] !== SOCKS_VERSION) return fail(new Error(`SOCKS5 协议版本不匹配：${head[0]}`))
      const rep = head[1]
      const atyp = head[3]
      let addrLen
      if (atyp === ATYP_IPV4) addrLen = 4
      else if (atyp === ATYP_IPV6) addrLen = 16
      else if (atyp === ATYP_DOMAIN) {
        // 域名长度字段 + 域名本身
        return readExactly(socket, 1, (lenBuf) => {
          finishReply(rep, lenBuf[0])
        }, fail)
      } else return fail(new Error(`SOCKS5 应答含未知地址类型：${atyp}`))
      finishReply(rep, addrLen)
    }, fail)
  }

  /** 读取并丢弃 BND.ADDR + BND.PORT，然后判定结果 */
  const finishReply = (rep, addrLen) => {
    readExactly(socket, addrLen + 2, () => {
      if (rep !== 0x00) return fail(new Error(`SOCKS5 连接失败：${REP_MESSAGE[rep] || `应答码 ${rep}`}`))
      succeed()
    }, fail)
  }

  socket.once('connect', () => {
    // 1) 打招呼：声明支持的认证方式
    const methods = hasAuth ? [AUTH_NONE, AUTH_USERPASS] : [AUTH_NONE]
    socket.write(Buffer.from([SOCKS_VERSION, methods.length, ...methods]))
    // 2) 按代理选择的方式走认证或直接发 CONNECT
    readExactly(socket, 2, (buf) => {
      if (buf[0] !== SOCKS_VERSION) return fail(new Error(`SOCKS5 协议版本不匹配：${buf[0]}`))
      const method = buf[1]
      if (method === AUTH_NONE) return sendConnect()
      if (method === AUTH_USERPASS) return hasAuth ? sendAuth() : fail(new Error('SOCKS5 代理要求用户名/密码认证，但未配置'))
      fail(new Error(`SOCKS5 代理不接受可用的认证方式（返回 0x${method.toString(16)}）`))
    }, fail)
  })
}

/** ============================ Agent ============================ */

/** 建立隧道；withTls=true 时在隧道上再叠一层 TLS（用于 https 目标） */
function createSocksSocket(socksOpts, options, withTls, callback) {
  const host = options.hostname || options.host
  if (!host) return callback(new Error('未知的目标主机'))
  const port = Number(options.port) || (withTls ? 443 : 80)

  socksConnect({
    ...socksOpts,
    targetHost: host,
    targetPort: port,
  }, (err, socket) => {
    if (err) return callback(err)
    if (!withTls) return callback(null, socket)

    const tlsSocket = tls.connect({
      socket,
      servername: options.servername || host,
      rejectUnauthorized: options.rejectUnauthorized !== false,
    })
    tlsSocket.once('secureConnect', () => { callback(null, tlsSocket) })
    tlsSocket.once('error', (e) => {
      try { tlsSocket.destroy() } catch { /* noop */ }
      callback(e)
    })
  })
}

/**
 * 生成 SOCKS5 Agent 类。
 * 必须分别继承 http.Agent / https.Agent：Node 会校验 agent.protocol 与请求协议一致。
 */
function createSocksAgentClass(BaseAgent, withTls) {
  return class Socks5Agent extends BaseAgent {
    constructor(socksOpts) {
      super({ keepAlive: true })
      this.__socksOpts = socksOpts
    }

    createConnection(options, callback) {
      createSocksSocket(this.__socksOpts, options, withTls, callback)
    }
  }
}

const Socks5HttpAgent = createSocksAgentClass(http.Agent, false)
const Socks5HttpsAgent = createSocksAgentClass(https.Agent, true)

/** ============================ 本地 HTTP 桥 ============================ */

/**
 * 起一个只监听 127.0.0.1 的 HTTP 代理，把请求经 SOCKS5 隧道转发出去。
 *
 * 会话层（音乐播放/封面）**一律**经过它，而不是直接给 Chromium 配 `socks5://`：
 *  1. Chromium 对 SOCKS5 代理会在本地解析 DNS（远程 DNS 不生效），本地解析不了/被污染
 *     的域名播放就会失败；HTTP 代理的 CONNECT 会把域名原样交给本桥，由桥按 remoteDns
 *     转发，域名始终由代理端解析；
 *  2. Chromium 不支持带用户名/密码认证的 SOCKS5 —— URL 里的凭据会被静默忽略（参见
 *     electron-session-proxy / electron-viasocks 等项目的说明），认证由本桥完成。
 * 向 Chromium 暴露的是一个普通的 `http://127.0.0.1:<随机端口>` 代理。
 *
 * 处理 Chromium 走 HTTP 代理时的两种请求形态：
 *   - `CONNECT host:port`（https 目标）→ 建隧道后原样双向转发；
 *   - 绝对 URI 的普通请求（http 目标）→ 用一次性 agent 经隧道发出。
 */
function createBridge(socksOptsFactory) {
  const sockets = new Set()
  const track = socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    return socket
  }

  const tunnel = (host, port, cb) => {
    socksConnect(Object.assign({}, socksOptsFactory(), {
      targetHost: host,
      targetPort: port,
    }), (err, socket) => {
      if (err) return cb(err)
      cb(null, track(socket))
    })
  }

  const onConnect = (req, clientSocket, head) => {
    track(clientSocket)
    const m = /^([^\s:]+):(\d+)$/.exec(String(req.url || '').trim())
    if (!m) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    tunnel(m[1], Number(m[2]), (err, upstream) => {
      if (err) {
        try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') } catch { /* noop */ }
        return
      }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length) upstream.write(head)
      clientSocket.once('error', () => { try { upstream.destroy() } catch { /* noop */ } })
      upstream.once('error', () => { try { clientSocket.destroy() } catch { /* noop */ } })
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
    })
  }

  const onRequest = (req, res) => {
    let target = null
    try { target = new URL(req.url) } catch { target = null }
    if (!target || !/^https?:$/.test(target.protocol)) {
      res.writeHead(400).end('仅支持绝对 URI 的 http 代理请求')
      return
    }
    if (target.protocol === 'https:') {
      // https 目标 Chromium 一律走 CONNECT，这里兜底拒绝，避免 TLS 语义错误
      res.writeHead(501).end('https 目标请使用 CONNECT')
      return
    }
    const port = Number(target.port) || 80
    tunnel(target.hostname, port, (err, socket) => {
      if (err) {
        res.writeHead(502).end(String((err && err.message) || err))
        return
      }
      // 一次性 agent：让 http.request 直接复用已经建好的隧道 socket
      const agent = new http.Agent({ keepAlive: false })
      agent.createConnection = (opts, cb) => { cb(null, socket) }
      const headers = Object.assign({}, req.headers)
      delete headers['proxy-connection']
      const upstream = http.request({
        host: target.hostname,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        agent,
      }, upRes => {
        res.writeHead(upRes.statusCode || 502, upRes.headers)
        upRes.pipe(res)
      })
      upstream.once('close', () => { try { agent.destroy() } catch { /* noop */ } })
      upstream.once('error', err2 => {
        try { socket.destroy() } catch { /* noop */ }
        if (!res.headersSent) res.writeHead(502)
        res.end(String((err2 && err2.message) || err2))
      })
      req.pipe(upstream)
    })
  }

  const server = http.createServer(onRequest)
  server.on('connect', onConnect)
  server.on('clientError', (_err, socket) => {
    try { socket.destroy() } catch { /* noop */ }
  })

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    for (const s of sockets) { try { s.destroy() } catch { /* noop */ } }
    sockets.clear()
    try { server.close() } catch { /* noop */ }
  }
  return { server, close }
}

/** 启动本地桥并返回 { port, close }；只监听回环地址，不对外暴露 */
function startBridge(socksOptsFactory, callback) {
  const bridge = createBridge(socksOptsFactory)
  let settled = false
  bridge.server.once('error', err => {
    if (settled) return
    settled = true
    bridge.close()
    callback(err)
  })
  bridge.server.listen(0, '127.0.0.1', () => {
    if (settled) return
    settled = true
    callback(null, { port: bridge.server.address().port, close: bridge.close })
  })
}

/** ============================ 插件生命周期 ============================ */

/** 连接测试使用的目标（只建隧道，不发送业务数据） */
const TEST_TARGET = { host: 'www.baidu.com', port: 443 }

/**
 * 默认配置。全部可在「插件管理（侧边栏）→ sock_proxy → 设置」中修改，
 * 账户名与密码都留空时使用「无认证」方式（RFC 1928 AUTH_NONE）。
 */
const DEFAULT_CONFIG = {
  /** 是否启用 SOCKS5 代理（关闭时完全不接管网络请求） */
  enable: false,
  /** 代理地址（为空时不接管） */
  host: '',
  /** 代理端口（留空时用 defaultPort） */
  port: '',
  /** 账户名 / 密码；两者都为空 → 无认证 */
  username: '',
  password: '',
  /** true：把域名交给代理解析（远程 DNS，推荐，避免本地 DNS 泄漏）；false：本地解析后再连接 */
  remoteDns: true,
  /** 感知探活：开启后每 10 分钟自动探测代理是否可达，不可达则自动停用并切回本地网络 */
  healthCheck: false,
  /** 握手超时（毫秒） */
  timeout: DEFAULT_TIMEOUT,
  /** 代理端口留空时的默认端口 */
  defaultPort: DEFAULT_SOCKS_PORT,
}

/** setup 时写入，供 module 上的生命周期回调使用（它们拿不到 setup 的作用域） */
let applyExternalConfig = null
let runConnectionTest = null
/** 卸载时撤销「会话代理」接管（关掉本地桥 + 通知宿主恢复原代理） */
let teardownSessionProxy = null
/** 卸载时停止探活定时器（renderer 端专属，main 端不会启动定时器） */
let stopHealthCheckRef = null

module.exports = {
  setup(api) {
    // 启动诊断：main 端把关键里程碑追加到插件目录 boot-debug.log（GUI 启动时
    // console 输出不可见，用文件才能排查「桥为什么没起来」这类问题）
    const bootLog = (msg) => {
      if (api.platform !== 'main') return
      try {
        require('fs').appendFileSync(
          require('path').join(typeof __dirname === 'string' ? __dirname : '.', 'boot-debug.log'),
          `${new Date().toISOString()} [pid:${process.pid}] ${msg}\n`,
        )
      } catch { /* 诊断失败不影响功能 */ }
    }
    bootLog(`setup 进入（platform=${api.platform}，setSessionProxy=${typeof api.setSessionProxy}）`)
    const lx = api.app
    if (!lx) {
      bootLog('未拿到 window.lx，提前返回')
      api.logger.warn('未拿到 window.lx，插件无法接管代理 agent')
      return
    }
    // 本插件同时跑在 renderer 与 main 两端：
    //  - renderer：接管 Node 请求的 http.Agent（window.lx.pluginNetAgent）
    //  - main：接管 Chromium 会话代理（api.setSessionProxy），让播放也走代理
    const isRenderer = api.platform === 'renderer'

    // 配置来自插件自己的 config.json（<插件目录>/config.json），启动时自动载入
    const config = Object.assign({}, DEFAULT_CONFIG, api.getConfig())
    // key: `${https?}://${proxyHost}:${proxyPort}` → agent（同一代理+协议复用，keepAlive 才能真正生效）
    const agents = new Map()
    let loggedOnce = false
    let warnedConflict = false
    /** 最近一次运行状态，显示在设置面板上 */
    let status = ''
    /** 会话层（播放/封面）转发用的本地 HTTP 桥（始终使用，见 applySessionProxy 注释） */
    let bridge = null
    /** 桥的代际号：配置快速变化时丢弃过期的启动结果 */
    let bridgeGeneration = 0
    /** 当前已声明给宿主的会话代理规则（空串表示未接管） */
    let sessionProxyRules = ''

    const proxyPortOf = () => String(config.port || '') || String(config.defaultPort)
    const hasAuth = () => !!(config.username || config.password)
    const readConfig = () => Object.assign({}, config)

    const describe = () => {
      if (!config.enable) return '未启用'
      if (!config.host) return '已启用，但还没填写代理地址'
      const auth = hasAuth() ? '用户名/密码认证' : '无认证'
      const dns = config.remoteDns ? '远程' : '本地'
      // 会话层（音乐播放 / 封面）由 main 端负责：能拿到桥端口就报出来；
      // 拿不到（renderer 端的设置面板）就说明「由主进程建立」，别误报成「未就绪」。
      let playback
      if (bridge) playback = `本地桥 127.0.0.1:${bridge.port}（域名由代理解析）`
      else playback = typeof api.setSessionProxy === 'function' ? '本地桥启动中…' : '本地桥（由主进程建立）'
      return `已接管：SOCKS5 ${config.host}:${proxyPortOf()}（${dns} DNS，${auth}）；播放层 ${playback}`
    }
    status = describe()

    /** 当前配置对应的 SOCKS5 握手参数（agent / 本地桥 / 连接测试共用） */
    const socksOpts = () => ({
      proxyHost: config.host,
      proxyPort: Number(proxyPortOf()),
      username: config.username,
      password: config.password,
      remoteDns: config.remoteDns,
      timeout: config.timeout,
    })

    const stopBridge = () => {
      bridgeGeneration++
      if (!bridge) return
      try { bridge.close() } catch { /* noop */ }
      bridge = null
    }

    /**
     * 应用「会话代理」：让 <audio>/<img> 等由 Chromium 直接发起的请求（音乐播放、封面）
     * 也走 SOCKS5。
     *
     * 一律通过本地 HTTP 桥转发（`http://127.0.0.1:<随机端口>`），不直接用 Chromium 原生的
     * `socks5://`，原因有二：
     *  1. Chromium 对 SOCKS5 代理会在**本地解析 DNS**（不像 curl 的 socks5h），本地解析
     *     不了/被污染的域名播放就会失败，而 Node 层（remoteDns）却正常 —— 正是
     *     「菜单能走代理、播放不行」的根因。HTTP 代理的 CONNECT 会把域名原样交给桥，
     *     由桥按 remoteDns 设置转发，域名始终由代理端解析；
     *  2. Chromium 会静默忽略 SOCKS URL 里的用户名/密码，认证统一在桥里完成。
     * 桥启动失败（极端情况）才退回 Chromium 原生 `socks5://`，聊胜于无。
     *
     * 宿主未提供 api.setSessionProxy（老宿主）时静默跳过，插件仍能接管 Node 请求。
     */
    const applySessionProxy = () => {
      if (typeof api.setSessionProxy !== 'function') {
        bootLog('applySessionProxy：宿主未提供 setSessionProxy，跳过')
        return
      }
      bootLog(`applySessionProxy：enable=${config.enable} host=${config.host} port=${proxyPortOf()}`)
      if (!config.enable || !config.host) {
        stopBridge()
        sessionProxyRules = ''
        api.setSessionProxy(null)
        bootLog('applySessionProxy：未启用/未填地址 → 已撤销会话代理')
        return
      }
      stopBridge()
      sessionProxyRules = ''
      api.setSessionProxy(null)
      bootLog('applySessionProxy：正在启动本地桥…')
      const generation = bridgeGeneration
      startBridge(() => socksOpts(), (err, handle) => {
        if (generation !== bridgeGeneration) {
          // 期间配置又变了，丢弃这次结果
          bootLog(`applySessionProxy：桥启动完成但代际已过期（gen=${generation}），丢弃`)
          if (handle) { try { handle.close() } catch { /* noop */ } }
          return
        }
        if (err) {
          bootLog(`applySessionProxy：桥启动失败 → 回退 socks5://（${err.message}）`)
          sessionProxyRules = `socks5://${config.host}:${proxyPortOf()}`
          api.setSessionProxy(sessionProxyRules)
          status = describe()
          api.logger.error('启动本地桥失败，已退回 Chromium 原生 SOCKS5（该模式本地解析 DNS、不支持认证）：', err.message)
          return
        }
        bridge = handle
        sessionProxyRules = `http://127.0.0.1:${handle.port}`
        api.setSessionProxy(sessionProxyRules)
        status = describe()
        bootLog(`applySessionProxy：桥已启动 127.0.0.1:${handle.port} → 会话代理已声明`)
      })
    }

    const agentFor = (secure, proxyHost, proxyPort) => {
      const key = `${secure ? 'https' : 'http'}://${proxyHost}:${proxyPort}`
      let agent = agents.get(key)
      if (!agent) {
        agent = secure ? new Socks5HttpsAgent(socksOpts()) : new Socks5HttpAgent(socksOpts())
        agents.set(key, agent)
      }
      return agent
    }

    /** 连接参数变化时丢弃旧 agent（keepAlive 连接是按旧参数建立的，必须重建） */
    const dropAgents = () => {
      for (const agent of agents.values()) {
        try { agent.destroy() } catch { /* noop */ }
      }
      agents.clear()
      loggedOnce = false
    }

    /** ============================ 感知探活 ============================ */
    /**
     * 感知探活：开启后每 10 分钟自动探测 SOCKS5 代理是否可达；
     * 探测失败则自动停用代理（节点请求与播放都切回本地网络 / 直连）。
     */
    const PROBE_INTERVAL_MS = 10 * 60 * 1000
    /** 单次探测超时（毫秒）：只测端口 TCP 可达性，故用短超时避免挂起 */
    const PROBE_TIMEOUT_MS = 5000
    /** 首次探测失败后，间隔多久复测一次以确认（避免瞬时抖动误停，毫秒） */
    const PROBE_RETRY_MS = 20000
    /** 最近一次探活结果 { ok, at }；null 表示尚未探测 */
    let lastProbe = null
    /** 是否因探活失败而自动停用（用于重置判断与状态展示） */
    let autoDisabled = false
    /** 探活定时器句柄；null 表示未运行（main 端始终为 null，定时器只在 renderer 端跑） */
    let healthTimer = null
    /** 复测定时器句柄（首次失败后短延时复测，避免瞬时抖动误停） */
    let confirmTimer = null
    /** 是否处于“首次失败待复测”状态 */
    let pendingFail = false

    /**
     * 单次探测：直接 TCP 连接代理的 host:port，验证「代理服务在监听、地址可用」。
     * 只测端口可达性，不依赖本地 DNS 解析、也不依赖代理能否出网，从而避免把
     * “外网目标不可达 / 本地 DNS 异常”误判为“代理不可用”。带短超时，避免挂起。
     */
    const probeProxy = () => new Promise((resolve) => {
      // 防御：未启用 / 未填地址 / 未开探活 → 视为「无需探活」，不触发停用
      if (!config.enable || !config.host || !config.healthCheck) return resolve({ ok: true, skipped: true })
      const port = Number(proxyPortOf())
      if (!port) return resolve({ ok: true, skipped: true })
      let settled = false
      const socket = net.connect({ host: config.host, port, timeout: PROBE_TIMEOUT_MS })
      const done = (ok) => {
        if (settled) return
        settled = true
        socket.removeAllListeners()
        try { socket.destroy() } catch { /* noop */ }
        resolve({ ok })
      }
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
      socket.once('timeout', () => done(false))
    })

    /** 停止探活定时器（不重置状态标记，但会清掉待复测定时器与待复测状态） */
    const stopHealthCheck = () => {
      if (healthTimer) { clearInterval(healthTimer); healthTimer = null }
      if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null }
      pendingFail = false
    }

    /** 清除探活状态标记（自动停用标记、上次探测记录、待复测状态），供「重新勾选」时重置 */
    const resetProbeState = () => {
      autoDisabled = false
      lastProbe = null
      pendingFail = false
    }

    /** 单次探测结果处理：失败先短延时复测，连续两次失败才认定不可用并停用 */
    const onProbeResult = ({ ok, skipped }) => {
      if (skipped) return
      lastProbe = { ok, at: Date.now() }
      if (ok) { pendingFail = false; status = describe(); return }
      if (pendingFail) {
        // 复测仍失败 → 确认代理不可用，自动停用并切回本地网络
        pendingFail = false
        autoDisabled = true
        stopHealthCheck()
        api.logger.warn(`感知探活：SOCKS5 代理 ${config.host}:${proxyPortOf()} 连续两次探测不可达，自动停用代理并切回本地网络`)
        // 设为未启用：provider 不再接管节点请求，applySessionProxy 撤销 Chromium 会话代理（切回本地网络）；
        // api.setConfig 经 IPC 通知 main 端同步，播放层一并恢复直连。
        applyConfig({ enable: false }, true)
        status = `感知探活失败（${new Date().toLocaleString()}）：代理 ${config.host}:${proxyPortOf()} 连续两次不可达，已自动停用并切回本地网络（在「设置」重新勾选「启用 SOCKS5 代理」或「感知探活」可恢复）`
        return
      }
      // 首次失败：进入“待复测”状态，短延时后复测一次确认
      pendingFail = true
      status = `感知探活：代理 ${config.host}:${proxyPortOf()} 不可达，将在 ${Math.round(PROBE_RETRY_MS / 1000)}s 后复测确认（避免瞬时抖动误停）`
      confirmTimer = setTimeout(() => {
        confirmTimer = null
        if (!config.healthCheck || !config.enable || !config.host) { pendingFail = false; return }
        probeProxy().then(onProbeResult).catch(() => { pendingFail = false })
      }, PROBE_RETRY_MS)
    }

    /** 依据当前配置启停探活定时器（地址 / 启用 / 探活任一变化都重新评估） */
    const startHealthCheck = () => {
      stopHealthCheck()
      // 定时器只在 renderer 端运行：renderer 的 api.setConfig 会经 IPC 通知 main 端插件
      // 同步停用会话代理（切回本地网络），因此无需在 main 端再跑一份。
      if (isRenderer && config.healthCheck && config.enable && config.host) {
        healthTimer = setInterval(() => {
          // 期间配置可能变化，重新把关，避免误停用
          if (!config.healthCheck || !config.enable || !config.host) return
          probeProxy().then(onProbeResult).catch(() => { /* 探测异常保持静默，等下个周期再试 */ })
        }, PROBE_INTERVAL_MS)
      }
    }

    /**
     * 代理 agent 接管函数：由 src/renderer/utils/request.js 的 getRequestAgent 调用。
     * 返回假值表示不接管（未启用 / 未填地址 / 非 http(s) 请求），交还原逻辑。
     * 是否接管只看本插件自己的配置，与 app 的 HTTP 代理设置无关。
     */
    const provider = (url, proxyOptions = null) => {
      if (!config.enable || !config.host) return undefined
      if (typeof url !== 'string' || !/^https?:/i.test(url)) return undefined

      const secure = /^https:/i.test(url)
      if (!warnedConflict && proxyOptions && proxyOptions.host) {
        warnedConflict = true
        api.logger.warn('app 自身的「网络代理」也开着，本插件优先接管；如非本意请到 设置 → 网络 关闭 app 的 HTTP 代理')
      }
      if (!loggedOnce) {
        loggedOnce = true
        api.logger.info(`已接管网络请求：SOCKS5 ${config.host}:${proxyPortOf()}（${describe()}）`)
      }
      return agentFor(secure, config.host, proxyPortOf())
    }

    /**
     * 应用新配置。
     * @param {object} patch 新配置（来自设置面板或 DevTools）
     * @param {boolean} persist 是否写回插件目录的 config.json
     */
    const applyConfig = (patch, persist) => {
      const keyOf = c => `${c.enable}|${c.host}|${c.port}|${c.username}|${c.password}|${c.remoteDns}`
      const before = keyOf(config)
      const wasEnabled = config.enable
      const wasHealth = config.healthCheck
      Object.assign(config, patch || {})
      const nowEnabled = config.enable
      const nowHealth = config.healthCheck

      // 重新勾选「启用 SOCKS5 代理」或「感知探活」→ 重置探活状态
      // （清除自动停用标记、清空上次探测记录，并由下方 startHealthCheck 重开定时器）。
      if ((!wasEnabled && nowEnabled) || (!wasHealth && nowHealth)) resetProbeState()

      if (keyOf(config) !== before) dropAgents()
      if (persist !== false) api.setConfig(readConfig())
      // 开关打开时挂上接管点；开关关闭（含探活自动停用）时显式摘掉，确保节点请求 100% 回到宿主默认行为，
      // 不依赖 provider 返回 undefined 的隐式 fallback。pluginNetAgent 仅 renderer 端有。
      if (isRenderer) {
        if (config.enable && config.host) {
          if (lx.pluginNetAgent !== provider) lx.pluginNetAgent = provider
        } else if (lx.pluginNetAgent === provider) {
          lx.pluginNetAgent = null
        }
      }
      // 会话代理（Chromium 层，播放/封面走的这一层）随配置同步更新；main 端才有该能力
      applySessionProxy()
      // 探活定时器随配置（启用 / 探活 / 地址）同步启停
      startHealthCheck()
      status = describe()
      return readConfig()
    }

    /** 建立一次到 TEST_TARGET 的隧道，用于验证地址/端口/账号密码是否正确 */
    const testConnection = async() => {
      if (!config.host) {
        status = '测试失败：请先填写代理地址'
        return
      }
      status = `正在测试 ${config.host}:${proxyPortOf()} …`
      const started = Date.now()
      await new Promise(resolve => {
        socksConnect(Object.assign(socksOpts(), {
          targetHost: TEST_TARGET.host,
          targetPort: TEST_TARGET.port,
        }), (err, socket) => {
          const cost = Date.now() - started
          if (err) {
            status = `测试失败（${cost}ms）：${err.message}`
          } else {
            status = `连接正常（${cost}ms）：已建立到 ${TEST_TARGET.host}:${TEST_TARGET.port} 的隧道`
            try { socket.destroy() } catch { /* noop */ }
          }
          resolve()
        })
      })
      api.logger.info('SOCKS5 连接测试：', status)
    }

    applyExternalConfig = applyConfig
    runConnectionTest = testConnection
    stopHealthCheckRef = stopHealthCheck
    teardownSessionProxy = () => {
      stopBridge()
      sessionProxyRules = ''
      if (typeof api.setSessionProxy === 'function') api.setSessionProxy(null)
    }

    // 启用后立刻接管；未启用时保持 window.lx.pluginNetAgent 原状（默认 null）
    if (isRenderer && config.enable && config.host) lx.pluginNetAgent = provider
    // 会话代理：让播放、封面等由 Chromium 直接发起的请求也走 SOCKS5
    try {
      applySessionProxy()
    } catch (err) {
      bootLog(`applySessionProxy 抛错：${err && err.stack || err}`)
      throw err
    }
    bootLog('setup 完成')

    // 启动时若已启用「感知探活」且代理已配置，立即按当前配置启停探活定时器
    startHealthCheck()

    // ---- 声明式设置面板（宿主统一渲染，配置保存到插件目录 config.json）----
    if (api.registerSettings) {
      api.registerSettings({
        title: 'SOCKS5 代理',
        fields: [
          { type: 'switch', key: 'enable', label: '启用 SOCKS5 代理', default: false, tip: '关闭时完全不接管网络请求。' },
          { type: 'text', key: 'host', label: '代理地址', placeholder: '127.0.0.1', default: '' },
          { type: 'text', key: 'port', label: '代理端口', placeholder: String(DEFAULT_SOCKS_PORT), default: '' },
          { type: 'text', key: 'username', label: '账户名', placeholder: '留空表示不需要认证', default: '' },
          { type: 'password', key: 'password', label: '密码', placeholder: '留空表示不需要认证', default: '' },
          {
            type: 'switch',
            key: 'remoteDns',
            label: '远程 DNS（由代理解析域名）',
            default: true,
            tip: '建议开启：避免本地 DNS 泄漏，也能解析本地被污染或不可达的域名。',
          },
          {
            type: 'switch',
            key: 'healthCheck',
            label: '感知探活（每 10 分钟）',
            default: false,
            tip: '开启后每 10 分钟自动探测 SOCKS5 代理是否可达；探测失败将自动停用代理并切回本地网络（在「设置」重新勾选可恢复）。',
          },
          { type: 'divider' },
          {
            type: 'info',
            text: () => {
              let extra = ''
              if (config.healthCheck) {
                if (autoDisabled) extra = '（因连续两次探活失败已自动停用，重新勾选可恢复）'
                else if (pendingFail) extra = '（首次探活失败，复测中…）'
                else if (lastProbe) extra = lastProbe.ok ? '（上次探活：可达）' : '（上次探活：不可达）'
                else extra = '（探活已开启，每 10 分钟检测一次）'
              }
              return status + extra
            },
          },
          { type: 'button', label: '测试连接', action: 'test' },
        ],
      })
    }

    // 方便在 DevTools 控制台查看 / 调整配置
    const g = typeof window !== 'undefined' ? window : global
    g.lxPlugins = g.lxPlugins || {}
    g.lxPlugins.sockProxy = {
      getConfig: readConfig,
      setConfig: (patch) => applyConfig(patch, true),
      isActive: () => lx.pluginNetAgent === provider,
      /** 当前声明的 Chromium 会话代理规则；空串表示未接管（播放会直连） */
      sessionProxyRules: () => sessionProxyRules,
      bridgePort: () => (bridge ? bridge.port : null),
      status: () => status,
      /** 感知探活状态：是否开启、定时器是否在跑、上次探测结果、是否因探活而自动停用 */
      health: () => ({ enabled: config.healthCheck, running: !!healthTimer, lastProbe, autoDisabled, pendingFail }),
      /** 立即手动探活一次（返回 true=可达）；不改动配置，仅更新 lastProbe */
      forceProbe: () => probeProxy().then(({ ok }) => { lastProbe = { ok, at: Date.now() }; return ok }),
    }

    api.hooks.on('app:ready', () => {
      api.logger.info(`已就绪：v${api.version} → ${describe()}`)
      if (config.enable && !config.host) api.logger.warn('已启用 SOCKS5，但尚未填写代理地址')
    })
  },

  /** 设置面板改动配置后由宿主调用：立刻应用，无需重启客户端 */
  onConfigChange(next) {
    if (applyExternalConfig) applyExternalConfig(next, false)
    return undefined
  },

  /** 设置面板上的按钮被点击 */
  onSettingsAction(action) {
    if (action === 'test' && runConnectionTest) return runConnectionTest()
    return undefined
  },

  /** 卸载/禁用：撤掉接管点、关掉本地桥并断开 keepAlive 连接（本插件不 patch 任何原函数，宿主无需回退） */
  uninstall() {
    applyExternalConfig = null
    runConnectionTest = null
    if (stopHealthCheckRef) stopHealthCheckRef()
    stopHealthCheckRef = null
    if (teardownSessionProxy) teardownSessionProxy()
    teardownSessionProxy = null
    const wx = (typeof window !== 'undefined' && window.lx) || null
    const gx = (typeof global !== 'undefined' && global.lx) || null
    for (const host of [wx, gx]) {
      if (host && host.pluginNetAgent) host.pluginNetAgent = null
    }
    console.log('[plugin:sock_proxy] 已卸载，网络请求与播放恢复为客户端原生行为（HTTP 代理 / 直连）')
  },

  onUpdate(oldVersion) {
    console.log(`[plugin:sock_proxy] 已从 v${oldVersion} 更新（插件版本自动与 app 保持一致，配置仍保留在插件目录）`)
  },
}
