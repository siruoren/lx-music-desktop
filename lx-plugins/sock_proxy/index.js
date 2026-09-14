/**
 * sock_proxy —— 为客户端提供 SOCKS5 代理支持。
 *
 * 背景：客户端原生的网络代理只支持 HTTP 代理（`src/renderer/utils/request.js` 里
 * 固定用 `tunnel` 的 `httpOverHttp` / `httpsOverHttp` 构造 agent），而 `tunnel`
 * 本身不支持 SOCKS。本插件通过插件系统的「代理 agent 接管点」提供自实现的
 * SOCKS5 agent，从而让 SOCKS5 代理真正生效，且不改动原请求逻辑。
 *
 * 接管点约定（见 src/renderer/utils/request.js 与 src/plugins/renderer.ts）：
 *   window.lx.pluginNetAgent = (url, { host, port }) => agent | undefined
 *   - 返回 agent  → 用该 agent 发请求（本插件返回 SOCKS5 agent）
 *   - 返回 undefined → 不接管，交还原逻辑（HTTP 代理 / 直连）
 *
 * 生效范围：所有经 `src/renderer/utils/request.js` 的请求 —— 各音乐源的搜索 /
 * 歌单 / 歌词 / 评论 / 榜单 / 热词 / 封面等。
 * 未覆盖：下载任务另有一份独立的 agent 构造（`src/common/utils/download/util.ts`，
 * 运行在 download worker 中、且 worker 里拿不到 window.lx），详见 README「覆盖范围」。
 *
 * 配置：启用/禁用由「插件管理」页的开关控制；其余选项存在插件私有数据里，
 * 可在 DevTools 控制台用 window.lxPlugins.sockProxy.setConfig({...}) 修改。
 *
 * 入口以 CommonJS 导出（构建脚本会把它包进单个 .lxplugin 文件）：
 *   module.exports = { setup, uninstall, onUpdate }
 */
'use strict'

const net = require('net')
const tls = require('tls')
const http = require('http')
const https = require('https')
const dns = require('dns')

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

/** ============================ 插件生命周期 ============================ */

/** 默认配置；可在 DevTools 控制台用 window.lxPlugins.sockProxy.setConfig({...}) 修改 */
const DEFAULT_CONFIG = {
  /** true：把域名交给代理解析（远程 DNS，推荐）；false：本地解析后再连接 */
  remoteDns: true,
  /** SOCKS5 用户名/密码（可留空） */
  username: '',
  password: '',
  /** 握手超时（毫秒） */
  timeout: DEFAULT_TIMEOUT,
  /** 代理端口留空时的默认端口 */
  defaultPort: DEFAULT_SOCKS_PORT,
}

module.exports = {
  setup(api) {
    const lx = api.app
    if (!lx) {
      api.logger.warn('未拿到 window.lx，插件无法接管代理 agent')
      return
    }

    const config = Object.assign({}, DEFAULT_CONFIG, api.getData('config', {}))
    // key: `${https?}://${proxyHost}:${proxyPort}` → agent（同一代理+协议复用，keepAlive 才能真正生效）
    const agents = new Map()
    let loggedOnce = false

    const agentFor = (secure, proxyHost, proxyPort) => {
      const key = `${secure ? 'https' : 'http'}://${proxyHost}:${proxyPort}`
      let agent = agents.get(key)
      if (!agent) {
        const socksOpts = {
          proxyHost,
          proxyPort,
          username: config.username,
          password: config.password,
          remoteDns: config.remoteDns,
          timeout: config.timeout,
        }
        agent = secure ? new Socks5HttpsAgent(socksOpts) : new Socks5HttpAgent(socksOpts)
        agents.set(key, agent)
      }
      return agent
    }

    /**
     * 代理 agent 接管函数：由 src/renderer/utils/request.js 的 getRequestAgent 调用。
     * 返回 undefined 表示不接管（例如未配置代理、非 http(s) 请求），交还原逻辑。
     */
    const provider = (url, proxyOptions) => {
      if (!proxyOptions || !proxyOptions.host) return undefined
      if (typeof url !== 'string' || !/^https?:/i.test(url)) return undefined

      const secure = /^https:/i.test(url)
      const proxyPort = String(proxyOptions.port || '') || String(config.defaultPort)

      if (!loggedOnce) {
        loggedOnce = true
        api.logger.info(
          `已接管网络代理：SOCKS5 ${proxyOptions.host}:${proxyPort}` +
          `（远程 DNS：${config.remoteDns ? '开' : '关'}${config.username ? '，带认证' : ''}）`,
        )
      }
      return agentFor(secure, proxyOptions.host, proxyPort)
    }

    lx.pluginNetAgent = provider

    // 方便在 DevTools 控制台查看 / 调整配置，无需重新安装插件
    const g = typeof window !== 'undefined' ? window : global
    g.lxPlugins = g.lxPlugins || {}
    g.lxPlugins.sockProxy = {
      getConfig: () => Object.assign({}, config),
      setConfig: (patch) => {
        Object.assign(config, patch || {})
        api.setData('config', config)
        // 配置变了，旧 agent 作废（keepAlive 的连接按旧配置建立）
        for (const agent of agents.values()) agent.destroy()
        agents.clear()
        api.logger.info('配置已更新：', JSON.stringify(config))
        return Object.assign({}, config)
      },
      /** 当前是否已接管（供排查用） */
      isActive: () => lx.pluginNetAgent === provider,
    }

    api.hooks.on('app:ready', () => {
      api.logger.info(`已就绪：v${api.version}（设置 → 网络 → 网络代理 中填写 SOCKS5 主机/端口即可生效）`)
    })
  },

  /** 卸载/禁用：撤掉接管点并断开 keepAlive 连接（本插件不 patch 任何原函数，宿主无需回退） */
  uninstall() {
    const lx = (typeof window !== 'undefined' && window.lx) || null
    if (lx && lx.pluginNetAgent) lx.pluginNetAgent = null
    console.log('[plugin:sock_proxy] 已卸载，网络代理恢复为客户端原生（HTTP 代理）行为')
  },

  onUpdate(oldVersion) {
    console.log(`[plugin:sock_proxy] 已从 v${oldVersion} 更新到 v1.0.0`)
  },
}
