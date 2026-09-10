import { httpOverHttp, httpsOverHttp } from 'tunnel'
import { SocksProxyAgent } from 'socks-proxy-agent'

export const STATUS = {
  idle: 'IDLE',
  init: 'INIT',
  running: 'RUNNING',
  paused: 'PAUSED',
  stopped: 'STOPPED',
  completed: 'COMPLETED',
  error: 'ERROR',
  failed: 'FAILED',
} as const

const httpsRxp = /^https:/
export const getRequestAgent = (url: string, proxy?: { host: string, port: number, type?: 'http' | 'socks5' }) => {
  if (!proxy) return undefined
  if (proxy.type === 'socks5') {
    return new SocksProxyAgent(`socks5://${proxy.host}:${proxy.port}`)
  }
  const options = {
    proxy: {
      host: proxy.host,
      port: proxy.port,
    },
  }
  return httpsRxp.test(url) ? httpsOverHttp(options) : httpOverHttp(options)
}
