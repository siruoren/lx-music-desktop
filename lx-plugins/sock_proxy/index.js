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
 * 配置：全部在「设置 → 插件管理 → sock_proxy → 设置」中填写
 * （启用开关 / 地址 / 端口 / 账户名 / 密码 / 远程 DNS），
 * 保存在插件目录的 config.json，下次启动客户端自动生效。
 * 账户名与密码都留空时按 RFC 1928 使用「无认证」方式（AUTH_NONE）。
 *
 * 生效范围：所有经 `src/renderer/utils/request.js` 的请求 —— 各音乐源的搜索 /
 * 歌单 / 歌词 / 评论 / 榜单 / 热词 / 封面等。
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

/** 连接测试使用的目标（只建隧道，不发送业务数据） */
const TEST_TARGET = { host: 'www.baidu.com', port: 443 }

/**
 * 默认配置。全部可在「设置 → 插件管理 → sock_proxy → 设置」中修改，
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
  /** 握手超时（毫秒） */
  timeout: DEFAULT_TIMEOUT,
  /** 代理端口留空时的默认端口 */
  defaultPort: DEFAULT_SOCKS_PORT,
}

/** setup 时写入，供 module 上的生命周期回调使用（它们拿不到 setup 的作用域） */
let applyExternalConfig = null
let runConnectionTest = null

module.exports = {
  setup(api) {
    const lx = api.app
    if (!lx) {
      api.logger.warn('未拿到 window.lx，插件无法接管代理 agent')
      return
    }

    // 配置来自插件自己的 config.json（<插件目录>/config.json），启动时自动载入
    const config = Object.assign({}, DEFAULT_CONFIG, api.getConfig())
    // key: `${https?}://${proxyHost}:${proxyPort}` → agent（同一代理+协议复用，keepAlive 才能真正生效）
    const agents = new Map()
    let loggedOnce = false
    let warnedConflict = false
    /** 最近一次运行状态，显示在设置面板上 */
    let status = ''

    const proxyPortOf = () => String(config.port || '') || String(config.defaultPort)
    const hasAuth = () => !!(config.username || config.password)
    const readConfig = () => Object.assign({}, config)

    const describe = () => {
      if (!config.enable) return '未启用'
      if (!config.host) return '已启用，但还没填写代理地址'
      return `已接管：SOCKS5 ${config.host}:${proxyPortOf()}（${config.remoteDns ? '远程' : '本地'} DNS，${hasAuth() ? '用户名/密码认证' : '无认证'}）`
    }
    status = describe()

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

    /** 连接参数变化时丢弃旧 agent（keepAlive 连接是按旧参数建立的，必须重建） */
    const dropAgents = () => {
      for (const agent of agents.values()) {
        try { agent.destroy() } catch { /* noop */ }
      }
      agents.clear()
      loggedOnce = false
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
      Object.assign(config, patch || {})
      if (keyOf(config) !== before) dropAgents()
      if (persist !== false) api.setConfig(readConfig())
      // 开关打开时确保接管点已挂上；关闭时不摘掉，provider 自己会返回假值
      if (config.enable && config.host && lx.pluginNetAgent !== provider) lx.pluginNetAgent = provider
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
        socksConnect({
          proxyHost: config.host,
          proxyPort: Number(proxyPortOf()),
          targetHost: TEST_TARGET.host,
          targetPort: TEST_TARGET.port,
          username: config.username,
          password: config.password,
          remoteDns: config.remoteDns,
          timeout: config.timeout,
        }, (err, socket) => {
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

    // 启用后立刻接管；未启用时保持 window.lx.pluginNetAgent 原状（默认 null）
    if (config.enable && config.host) lx.pluginNetAgent = provider

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
            type: 'switch', key: 'remoteDns', label: '远程 DNS（由代理解析域名）', default: true,
            tip: '建议开启：避免本地 DNS 泄漏，也能解析本地被污染或不可达的域名。',
          },
          { type: 'divider' },
          { type: 'info', text: () => status },
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
      status: () => status,
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

  /** 卸载/禁用：撤掉接管点并断开 keepAlive 连接（本插件不 patch 任何原函数，宿主无需回退） */
  uninstall() {
    applyExternalConfig = null
    runConnectionTest = null
    const lx = (typeof window !== 'undefined' && window.lx) || null
    if (lx && lx.pluginNetAgent) lx.pluginNetAgent = null
    console.log('[plugin:sock_proxy] 已卸载，网络请求恢复为客户端原生行为（HTTP 代理 / 直连）')
  },

  onUpdate(oldVersion) {
    console.log(`[plugin:sock_proxy] 已从 v${oldVersion} 更新到 v2.0.0（配置仍保留在插件目录）`)
  },
}
