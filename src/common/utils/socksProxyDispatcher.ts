import { lookup } from 'node:dns/promises'
import { Agent, type Dispatcher } from 'undici'
import { SocksClient } from 'socks'

/**
 * undici 原生只支持 HTTP 代理（ProxyAgent 走 CONNECT），不支持 SOCKS5。
 * 这里构造一个自定义 Agent，其 connect 先经 SOCKS5 代理建立 TCP 隧道，
 * 返回原始套接字，由 undici 自行处理 https 目标的 TLS 握手（切勿在此手动 tls.connect，
 * 否则会与 undici 的 TLS 流程重复包裹导致 https 请求失败）。
 */
export const createSocksDispatcher = (proxyUrl: string): Dispatcher => {
  const { hostname, port, username, password } = new URL(proxyUrl)
  // socks5h 前缀：由 SOCKS5 代理做远程 DNS 解析（域名交给代理解析）
  // socks5  前缀：本机先做本地 DNS 解析，再把解析出的 IP 交给代理建隧道
  const isRemoteDns = proxyUrl.startsWith('socks5h')
  const proxy: {
    host: string
    port: number
    type: 5
    userId?: string
    password?: string
  } = {
    host: hostname,
    port: Number(port),
    type: 5,
  }
  // new URL() 会自动对 userinfo 做 percent-decode，这里直接透传给 socks 包即可
  if (username) proxy.userId = username
  if (password) proxy.password = password
  return new Agent({
    connect: async(opts) => {
      let host = opts.hostname ?? (opts as { host?: string }).host ?? ''
      if (!isRemoteDns) {
        // 本地 DNS 解析：先在本机把域名解析成 IP，再把 IP 交给 SOCKS 代理建立隧道
        try {
          const { address } = await lookup(host)
          host = address
        } catch {
          // 解析失败时回退为把原始 host 交给代理（代理侧再尝试解析）
        }
      }
      const { socket } = await SocksClient.createConnection({
        proxy,
        command: 'connect',
        destination: { host, port: Number(opts.port) },
      })
      return socket
    },
  })
}
