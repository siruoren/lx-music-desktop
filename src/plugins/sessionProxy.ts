/**
 * 插件系统 - Chromium 会话代理接管点（仅主进程）。
 *
 * 为什么需要它：
 *  1. 客户端自带的「网络代理」只支持 HTTP 代理，作用点是 BrowserWindow 的 Chromium
 *     会话（见 `src/main/modules/winMain/main.ts` 的 setSesProxy）。
 *  2. `<audio>` / `<img>` 等由 **Chromium 直接发起**的请求（音乐播放、封面加载）走的正是
 *     同一个会话，它们**不经过** `src/renderer/utils/request.js`，因此只挂载 Node 的
 *     http.Agent（`window.lx.pluginNetAgent`）无法影响播放 —— 会出现“接口能走代理、
 *     播放却依然直连”的现象。
 *  3. 所以要让 SOCKS5 之类的代理作用于「播放」，必须把代理设置到**会话**上。
 *
 * 约定：插件调用 `api.setSessionProxy(rules | null)` 声明会话代理规则。
 *  - `rules` 为 Electron 的 proxyRules 字符串，例如 `'socks5://127.0.0.1:1080'`、
 *    `'http://127.0.0.1:12345'`（指向插件自建的本地桥）；
 *  - 传 `null` 表示不再接管，回到 app 自身的网络代理设置。
 *
 * 插件声明的规则**优先于** app 自身的代理设置，并且在 app 重新应用代理
 * （用户改网络设置、重建窗口）之后依然生效：winMain 在应用前会先查询这里。
 */
import { session } from 'electron'

/** 主窗口的 Chromium 分区名；winMain 与本模块共用，避免两处硬编码 */
export const MAIN_WINDOW_PARTITION = 'persist:win-main'

/** 当前插件声明的会话代理规则；null 表示没有插件接管 */
let pluginRules: string | null = null
/** 由 winMain 注册：把主窗口会话的代理恢复成 app 自身的设置（回调而不是直接 import，避免循环引用） */
let restoreMainSession: (() => void) | null = null

/** 读取当前生效的插件会话代理规则（winMain 应用代理前查询） */
export const currentSessionProxyRules = (): string | null => pluginRules

/** winMain 注册“恢复为 app 自身代理”的回调 */
export const registerMainSessionProxyRestore = (fn: () => void): void => {
  restoreMainSession = fn
}

/**
 * 决定某个会话最终该用哪条代理规则（winMain 应用会话代理前调用）：
 *  - 有插件接管      → 用插件声明的规则（优先级最高，且 app 改配置后依然生效）
 *  - 否则有 app 代理 → 用 app 自身的 HTTP 代理
 *  - 都没有          → null，表示直连
 */
export const resolveSessionProxyRules = (
  appHost?: string,
  appPort?: string | number,
): string | null => {
  if (pluginRules) return pluginRules
  return appHost ? `http://${appHost}:${appPort}` : null
}

const normalize = (rules: string | null | undefined): string | null =>
  typeof rules === 'string' && rules.trim() ? rules.trim() : null

const applyTo = (ses: Electron.Session | null | undefined, rules: string | null | undefined): void => {
  if (!ses) return
  try {
    if (rules) void ses.setProxy({ mode: 'fixed_servers', proxyRules: rules })
    else void ses.setProxy({ mode: 'direct' })
  } catch (err) {
    console.error('[plugin] 设置会话代理失败：', err)
  }
}

/**
 * 声明 / 撤销插件的会话代理。
 *
 * 同时作用于**主窗口会话**（音乐播放、封面）与**默认会话**（自定义源所在的隐藏窗口），
 * 使两者里由 Chromium 发起的请求都走代理。
 */
export function setPluginSessionProxy(rules: string | null): void {
  pluginRules = normalize(rules)
  let main: Electron.Session | null = null
  try {
    main = session.fromPartition(MAIN_WINDOW_PARTITION)
  } catch (err) {
    // app 尚未 ready 时会抛错；此时规则已记下，等 winMain 建窗口时会自动应用
    console.warn('[plugin] 暂不可用会话（app 可能尚未 ready）：', err)
  }
  let def: Electron.Session | null = null
  try {
    def = session.defaultSession
  } catch { /* 同上，忽略 */ }

  if (pluginRules) {
    applyTo(main, pluginRules)
    applyTo(def, pluginRules)
    return
  }

  // 撤销接管：主窗口回到 app 自身的网络代理设置；默认会话 app 从不设置，恢复为直连
  if (restoreMainSession) restoreMainSession()
  else applyTo(main, null)
  applyTo(def, null)
}
