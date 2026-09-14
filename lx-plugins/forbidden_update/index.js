/**
 * forbidden_update —— 禁用客户端的「检查更新」。
 *
 * 原理（不改动任何源码，纯运行时拦截）：
 *   主窗口以 nodeIntegration:true / contextIsolation:false 运行，渲染端可以直接
 *   `require('electron')` 拿到 **进程内单例** 的 ipcRenderer；而客户端所有 IPC 都走
 *   `@common/rendererIpc`（内部就是对同一个 ipcRenderer 调 `.send()` / `.on()`）。
 *   因此把 ipcRenderer 上的这几个方法包一层，就能拦下更新的发起与回传。
 *
 * 拦截的三个方向：
 *   1. 出站：`send('update_check' | 'update_download_update' | 'quit_update')` 直接丢弃，
 *      主进程的 electron-updater 永远不会被触发。
 *   2. 入站：`on/once('update_*')` 直接不注册（覆盖插件加载之后才注册的监听）。
 *   3. 入站兜底：把「插件加载之前」已经注册好的 update 监听摘下来，卸载时原样装回
 *      —— 这样即使启动时那一次检查已经发出去，也不会有任何更新弹窗。
 *
 * 对应的 IPC 通道名见 src/common/ipcNames.ts 的 WIN_MAIN_RENDERER_EVENT_NAME；
 * 触发链路见 src/renderer/core/useApp/index.ts（启动检查）、
 * src/renderer/core/useApp/useUpdate.ts（事件处理）、
 * src/main/modules/winMain/autoUpdate.ts（主进程 electron-updater）。
 *
 * 入口以 CommonJS 导出（构建脚本会把它包进单个 .lxplugin 文件）：
 *   module.exports = { setup, uninstall, onUpdate }
 */
'use strict'

/** 渲染端 → 主进程：发起更新相关动作 */
const OUTGOING_CHANNELS = [
  'update_check', // 检查更新
  'update_download_update', // 下载更新
  'quit_update', // 退出并安装
]

/** 主进程 → 渲染端：更新状态回传（收到就会弹更新窗/自动下载） */
const INCOMING_CHANNELS = [
  'update_available',
  'update_not_available',
  'update_error',
  'update_progress',
  'update_downloaded',
]

/** 被摘下来的既有监听，用于卸载时还原：[{ channel, isOnce, listener }] */
let suspended = []

/**
 * setup 时保存的「未被打包」的原始 on/once。
 * 卸载回调是在宿主回退 patch **之前**执行的，那时 ipcRenderer.on 还是本插件的包装，
 * 直接用它会把要还原的监听又挡掉，所以必须走这里保存的原始方法。
 */
let rawOn = null
let rawOnce = null

function restoreSuspended(ipcRenderer) {
  const onFn = rawOn ?? ipcRenderer.on.bind(ipcRenderer)
  const onceFn = rawOnce ?? ipcRenderer.once.bind(ipcRenderer)
  let restored = 0
  for (const item of suspended) {
    try {
      if (item.isOnce) onceFn(item.channel, item.listener)
      else onFn(item.channel, item.listener)
      restored++
    } catch (err) {
      console.warn('[plugin:forbidden_update] 还原更新事件监听失败：', err)
    }
  }
  suspended = []
  return restored
}

module.exports = {
  setup(api) {
    let ipcRenderer
    try {
      ipcRenderer = require('electron').ipcRenderer
    } catch (err) {
      api.logger.error('无法 require("electron")，本插件需要在开启 nodeIntegration 的主窗口中使用：', err)
      return
    }
    if (!ipcRenderer || typeof ipcRenderer.send !== 'function') {
      api.logger.error('未拿到 ipcRenderer，无法禁用更新检查')
      return
    }

    const blockedOut = new Set(OUTGOING_CHANNELS)
    const blockedIn = new Set(INCOMING_CHANNELS)

    // 记录原始方法：卸载时要在 patch 仍生效的情况下把监听装回去，必须绕过自己的包装
    rawOn = ipcRenderer.on.bind(ipcRenderer)
    rawOnce = ipcRenderer.once.bind(ipcRenderer)

    // ---- 1) 出站：拦住一切发起更新的请求 ----
    api.patch(ipcRenderer, 'send', (next, channel, ...args) => {
      if (blockedOut.has(channel)) {
        api.logger.info(`已拦截更新请求：${channel}`)
        return
      }
      return next(channel, ...args)
    })

    // ---- 2) 入站：插件加载之后注册的 update 监听一律不生效 ----
    const dropIncoming = (next, channel, ...args) => {
      if (blockedIn.has(channel)) return ipcRenderer
      return next(channel, ...args)
    }
    api.patch(ipcRenderer, 'on', dropIncoming)
    api.patch(ipcRenderer, 'once', dropIncoming)

    // ---- 3) 入站兜底：摘掉插件加载之前就已注册的 update 监听 ----
    // 注意：useUpdate() 在 app.mount 期间就注册了这些监听，很可能早于插件加载，
    // 只靠 on/once 的包装是拦不住它们的。
    for (const channel of INCOMING_CHANNELS) {
      let raw = []
      try {
        raw = (ipcRenderer.rawListeners ?? ipcRenderer.listeners).call(ipcRenderer, channel) || []
      } catch (err) {
        api.logger.warn(`读取 ${channel} 的既有监听失败：`, err)
      }
      if (!raw.length) continue
      for (const listener of raw) {
        // once() 注册的监听在 EventEmitter 内部是带 .listener 的包装函数
        const original = typeof listener.listener === 'function' ? listener.listener : null
        suspended.push({ channel, isOnce: !!original, listener: original ?? listener })
      }
      ipcRenderer.removeAllListeners(channel)
      api.logger.info(`已暂停 ${channel} 的 ${raw.length} 个既有监听`)
    }

    // ---- 记录状态，便于在插件管理页/控制台确认 ----
    const g = typeof window !== 'undefined' ? window : global
    g.lxPlugins = g.lxPlugins || {}
    g.lxPlugins.forbiddenUpdate = {
      isActive: () => true,
      /** 停用/启用拦截（调试用；禁用插件本身也会走同样的还原逻辑） */
      outgoingChannels: () => OUTGOING_CHANNELS.slice(),
      incomingChannels: () => INCOMING_CHANNELS.slice(),
    }

    api.hooks.on('app:ready', () => {
      api.logger.info(`已就绪：v${api.version}，已禁用检查更新（拦截出站 ${OUTGOING_CHANNELS.length} 个通道、入站 ${INCOMING_CHANNELS.length} 个通道）`)
    })
  },

  /** 卸载/禁用：把摘下来的监听装回去；被包装的方法由宿主统一还原 */
  uninstall() {
    const electron = (() => {
      try { return require('electron') } catch { return null }
    })()
    const ipcRenderer = electron && electron.ipcRenderer
    if (ipcRenderer && suspended.length) {
      const restored = restoreSuspended(ipcRenderer)
      console.log(`[plugin:forbidden_update] 已还原 ${restored} 个更新事件监听`)
    }
    suspended = []
    rawOn = null
    rawOnce = null
    console.log('[plugin:forbidden_update] 已卸载，客户端恢复正常的检查更新行为')
  },

  onUpdate(oldVersion) {
    console.log(`[plugin:forbidden_update] 已从 v${oldVersion} 更新到 v1.0.0`)
  },
}
