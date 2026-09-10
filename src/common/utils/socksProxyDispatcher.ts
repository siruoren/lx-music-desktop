import tls from 'node:tls'
import { Agent, type Dispatcher } from 'undici'
import { SocksClient } from 'socks'

/**
 * undici 原生只支持 HTTP 代理（ProxyAgent 走 CONNECT），不支持 SOCKS5。
 * 这里构造一个自定义 Agent，其 connect 先经 SOCKS5 代理建立 TCP 隧道，
 * 再（对 https 目标）在其上做 TLS，从而让 undici 的请求走 SOCKS5 代理。
 */
export const createSocksDispatcher = (proxyUrl: string): Dispatcher => {
  const { hostname, port } = new URL(proxyUrl)
  const proxy = {
    host: hostname,
    port: Number(port),
    type: 5 as const,
  }
  return new Agent({
    connect: async(opts) => {
      const { socket } = await SocksClient.createConnection({
        proxy,
        command: 'connect',
        destination: { host: opts.hostname, port: Number(opts.port) },
      })
      if (opts.protocol === 'https:') {
        return tls.connect({
          socket,
          servername: opts.servername ?? opts.hostname,
          ALPNProtocols: ['http/1.1'],
        })
      }
      return socket
    },
  })
}
